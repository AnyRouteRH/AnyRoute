// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AgreementEscrow} from "./AgreementEscrow.sol";

/// @notice Verifies a complete signed jury tally. Signatures certify keys, not model execution or attestation.
contract DisputeOracle is Ownable2Step, EIP712, ReentrancyGuard {
    enum Path {
        None,
        PanelPending,
        Jury,
        Panel
    }
    enum Verdict {
        RefundPayer,
        PayPayee,
        Split
    }

    struct Vote {
        uint16 payeeBps;
        bytes signature;
    }

    struct Ruling {
        Path path;
        bytes32 evidenceRoot;
        uint256 juryVersion;
        uint256 participationBitmap;
        uint256 consensusBitmap;
        uint16 payeeBps;
        Verdict verdict;
        bytes32 tallyHash;
    }
    uint256 public constant MAX_JURY_SIZE = 32;
    bytes32 public constant VOTE_TYPEHASH = keccak256(
        "Vote(address escrow,uint256 id,uint256 milestone,bytes32 context,bytes32 evidenceRoot,uint256 juryVersion,uint16 payeeBps)"
    );
    address[] public jurySigners;
    mapping(address => uint256) public signerIndexPlusOne;
    uint256 public juryVersion;
    uint256 public threshold;
    address public panel;
    mapping(bytes32 => Ruling) public rulings;

    event JurySet(uint256 indexed version, address[] signers, uint256 threshold);
    event PanelSet(address indexed panel);
    event TallyRecorded(
        bytes32 indexed key,
        bytes32 evidenceRoot,
        uint256 version,
        uint256 participationBitmap,
        uint256 consensusBitmap,
        bytes32 tallyHash
    );
    event PanelRequired(bytes32 indexed key);
    event RulingPosted(
        bytes32 indexed key,
        address indexed escrow,
        uint256 id,
        uint256 milestone,
        Path path,
        Verdict verdict,
        uint16 payeeBps
    );

    error InvalidInput();
    error Unauthorized();
    error AlreadyPosted();
    error InvalidTally();
    error PanelNotRequired();

    constructor(address initialOwner, address[] memory signers, uint256 theta, address initialPanel)
        Ownable(initialOwner)
        EIP712("AnyRouteAgreementJury", "1")
    {
        if (initialPanel == address(0)) revert InvalidInput();
        panel = initialPanel;
        emit PanelSet(initialPanel);
        _setJury(signers, theta);
    }

    function setJury(address[] calldata signers, uint256 theta) external onlyOwner {
        _setJury(signers, theta);
    }

    function setPanel(address nextPanel) external onlyOwner {
        if (nextPanel == address(0) || signerIndexPlusOne[nextPanel] != 0) revert InvalidInput();
        panel = nextPanel;
        emit PanelSet(nextPanel);
    }

    function rulingKey(address escrow, uint256 id, uint256 milestone) public pure returns (bytes32) {
        return keccak256(abi.encode(escrow, id, milestone));
    }

    function voteDigest(address escrow, uint256 id, uint256 milestone, bytes32 evidenceRoot, uint16 bps)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    VOTE_TYPEHASH,
                    escrow,
                    id,
                    milestone,
                    AgreementEscrow(escrow).disputeContext(id, milestone),
                    evidenceRoot,
                    juryVersion,
                    bps
                )
            )
        );
    }

    /// @notice Any relayer may submit exactly one verdict per current signer before escrow expiry.
    /// @dev Exact split bps must agree; disputeContext refuses expired disputes, including hung tallies.
    function postRuling(
        address escrow,
        uint256 id,
        uint256 milestone,
        bytes32 evidenceRoot,
        Vote[] calldata votes
    ) external nonReentrant {
        bytes32 key = rulingKey(escrow, id, milestone);
        if (rulings[key].path != Path.None) revert AlreadyPosted();
        if (evidenceRoot == bytes32(0) || votes.length != jurySigners.length) revert InvalidTally();
        uint256 bitmap;
        uint256[] memory bits = new uint256[](votes.length);
        for (uint256 i; i < votes.length; ++i) {
            if (votes[i].payeeBps > 10_000) revert InvalidTally();
            address signer = ECDSA.recover(
                voteDigest(escrow, id, milestone, evidenceRoot, votes[i].payeeBps), votes[i].signature
            );
            uint256 index = signerIndexPlusOne[signer];
            if (index == 0) revert InvalidTally();
            uint256 bit = uint256(1) << (index - 1);
            if (bitmap & bit != 0) revert InvalidTally();
            bitmap |= bit;
            bits[i] = bit;
        }
        uint256 consensus;
        uint16 winner;
        for (uint256 i; i < votes.length; ++i) {
            uint256 count;
            uint256 agreeing;
            for (uint256 j; j < votes.length; ++j) {
                if (votes[i].payeeBps == votes[j].payeeBps) {
                    ++count;
                    agreeing |= bits[j];
                }
            }
            if (count >= threshold) {
                consensus = agreeing;
                winner = votes[i].payeeBps;
                break;
            }
        }
        Ruling storage r = rulings[key];
        r.path = consensus == 0 ? Path.PanelPending : Path.Jury;
        r.evidenceRoot = evidenceRoot;
        r.juryVersion = juryVersion;
        r.participationBitmap = bitmap;
        r.consensusBitmap = consensus;
        r.tallyHash = keccak256(abi.encode(votes));
        emit TallyRecorded(key, evidenceRoot, juryVersion, bitmap, consensus, r.tallyHash);
        if (consensus == 0) {
            emit PanelRequired(key);
            return;
        }
        _execute(key, escrow, id, milestone, winner);
    }

    /// @notice Panel execution is subject to the escrow's original dispute expiry; a hung tally cannot extend it.
    function postPanelRuling(address escrow, uint256 id, uint256 milestone, bytes32 evidenceRoot, uint16 bps)
        external
        nonReentrant
    {
        if (msg.sender != panel) revert Unauthorized();
        bytes32 key = rulingKey(escrow, id, milestone);
        Ruling storage r = rulings[key];
        if (r.path == Path.Jury || r.path == Path.Panel) revert AlreadyPosted();
        if (r.path != Path.PanelPending) revert PanelNotRequired();
        if (bps > 10_000 || evidenceRoot != r.evidenceRoot) revert InvalidInput();
        r.path = Path.Panel;
        _execute(key, escrow, id, milestone, bps);
    }

    function _execute(bytes32 key, address escrow, uint256 id, uint256 milestone, uint16 bps) private {
        Ruling storage r = rulings[key];
        r.payeeBps = bps;
        r.verdict = bps == 0 ? Verdict.RefundPayer : bps == 10_000 ? Verdict.PayPayee : Verdict.Split;
        emit RulingPosted(key, escrow, id, milestone, r.path, r.verdict, bps);
        AgreementEscrow(escrow).rule(id, milestone, bps);
    }

    function _setJury(address[] memory signers, uint256 theta) private {
        if (
            signers.length == 0 || signers.length > MAX_JURY_SIZE || theta <= signers.length / 2
                || theta > signers.length
        ) revert InvalidInput();
        for (uint256 i; i < jurySigners.length; ++i) {
            delete signerIndexPlusOne[jurySigners[i]];
        }
        delete jurySigners;
        for (uint256 i; i < signers.length; ++i) {
            if (signers[i] == address(0) || signers[i] == panel || signerIndexPlusOne[signers[i]] != 0) {
                revert InvalidInput();
            }
            jurySigners.push(signers[i]);
            signerIndexPlusOne[signers[i]] = i + 1;
        }
        threshold = theta;
        emit JurySet(++juryVersion, signers, theta);
    }
}
