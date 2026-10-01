import { readFileSync, writeFileSync } from "node:fs";
const declarations = [ ["AgreementEscrow", "agreementEscrowAbi"], ["DisputeOracle", "disputeOracleAbi"] ].map(([name, variable]) => `export const ${variable} = ${JSON.stringify(JSON.parse(readFileSync(`contracts/out/${name}.sol/${name}.json`, "utf8")).abi, null, 2)} as const;`);
writeFileSync("src/agreements/abi.ts", "// Generated from forge artifacts by scripts/export-agreement-abis.ts. Do not edit.\n" + declarations.join("\n") + "\nexport const agreementCreateAbi = agreementEscrowAbi;\n");
