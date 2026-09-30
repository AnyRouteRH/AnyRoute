// A DOM for the component tests. Bun's own WebCrypto stays in place (happy-dom's would shadow it).
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const nodeCrypto = globalThis.crypto;
GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "crypto", { value: nodeCrypto, configurable: true });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
