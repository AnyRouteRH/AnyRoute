// The client SDK (packages/client) is written against a DOM lib; the sidecar builds with the runtime's types only. The
// onboarding CLI imports the SDK, and these are the only names it needs that the runtime types do not declare globally.
type BufferSource = NodeJS.BufferSource;
type BodyInit = NonNullable<RequestInit["body"]>;
type HeadersInit = NonNullable<ConstructorParameters<typeof Headers>[0]>;
