// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title CreditMintEvents
/// @notice Public audit trail for the anonymous-credit mint. The mint's authorised signer records each paid
/// quote (hash of the quote id, amount, payment rail) and each signing keyset it publishes (id, hash of the
/// public keys, transparency-log reference), so anyone can reconcile issuance against payments and check
/// that every keyset a wallet sees was logged.
/// @dev Nothing here links a buyer to a token: no payer address, no blinded message, no signature and no
/// token id is ever passed in or stored. The only state kept is which quote-id hashes and keyset ids were
/// already recorded, to reject duplicates. msg.sender is always the mint signer.
contract CreditMintEvents is Ownable2Step {
    /// @notice Purchase rail. Append only: never reorder or insert above the last entry.
    enum Rail {
        /// USDG on-chain via x402 (stock-token payments settle through this rail too).
        UsdgX402,
        /// Shielded USDG note through a privacy-pool relayer.
        ShieldedUsdg,
        /// Conversion of prepaid account credits.
        PrepaidCredits,
        /// Lightning (BOLT12).
        Lightning
    }

    /// @notice Address authorised to record purchases and keysets (the mint).
    address public mintSigner;
    /// @notice Number of purchases recorded.
    uint256 public purchaseCount;
    /// @notice Number of keysets recorded.
    uint256 public keysetCount;

    /// @notice Whether a quote-id hash was already recorded.
    mapping(bytes32 quoteIdHash => bool) public purchased;
    /// @notice Whether a keyset id was already recorded.
    mapping(bytes32 keysetId => bool) public keysetPublished;

    /// @notice A quote was paid and may be issued as blinded credits.
    /// @param quoteIdHash Hash of the mint quote id.
    /// @param amount Credits paid for, in token units.
    /// @param rail Payment rail.
    event Purchased(bytes32 indexed quoteIdHash, uint256 amount, Rail rail);
    /// @notice The mint published a signing keyset.
    /// @param id Keyset id (an 8-byte id is left-aligned and zero-padded).
    /// @param pubkeysHash Hash of the keyset's canonical public-key map.
    /// @param rekorRef Transparency-log entry that published the keyset.
    event KeysetPublished(bytes32 indexed id, bytes32 pubkeysHash, bytes32 rekorRef);
    /// @notice The mint signer changed.
    event MintSignerSet(address indexed mintSigner);

    /// @notice Caller is not the mint signer.
    error NotMintSigner();
    /// @notice A required address is zero.
    error ZeroAddress();
    /// @notice A required value is zero.
    error ZeroValue();
    /// @notice The quote-id hash or keyset id was already recorded.
    error AlreadyRecorded();

    modifier onlyMintSigner() {
        if (msg.sender != mintSigner) revert NotMintSigner();
        _;
    }

    /// @param owner_ Owner (timelock).
    /// @param mintSigner_ The mint's authorised signer.
    constructor(address owner_, address mintSigner_) Ownable(owner_) {
        if (mintSigner_ == address(0)) revert ZeroAddress();
        mintSigner = mintSigner_;
        emit MintSignerSet(mintSigner_);
    }

    /// @notice Record a paid quote. Each quote-id hash can be recorded once.
    /// @param quoteIdHash Hash of the mint quote id. Non-zero.
    /// @param amount Credits paid for, in token units. Non-zero.
    /// @param rail Payment rail.
    function recordPurchase(bytes32 quoteIdHash, uint256 amount, Rail rail) external onlyMintSigner {
        if (quoteIdHash == bytes32(0) || amount == 0) revert ZeroValue();
        if (purchased[quoteIdHash]) revert AlreadyRecorded();
        purchased[quoteIdHash] = true;
        ++purchaseCount;
        emit Purchased(quoteIdHash, amount, rail);
    }

    /// @notice Record a published keyset. Each keyset id can be recorded once.
    /// @param id Keyset id. Non-zero.
    /// @param pubkeysHash Hash of the canonical public-key map. Non-zero.
    /// @param rekorRef Transparency-log entry reference. Non-zero.
    function publishKeyset(bytes32 id, bytes32 pubkeysHash, bytes32 rekorRef) external onlyMintSigner {
        if (id == bytes32(0) || pubkeysHash == bytes32(0) || rekorRef == bytes32(0)) revert ZeroValue();
        if (keysetPublished[id]) revert AlreadyRecorded();
        keysetPublished[id] = true;
        ++keysetCount;
        emit KeysetPublished(id, pubkeysHash, rekorRef);
    }

    /// @notice Set the mint signer.
    function setMintSigner(address mintSigner_) external onlyOwner {
        if (mintSigner_ == address(0)) revert ZeroAddress();
        mintSigner = mintSigner_;
        emit MintSignerSet(mintSigner_);
    }
}
