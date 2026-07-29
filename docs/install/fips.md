---
summary: "Wire OpenClaw to an operator-supplied FIPS-capable Node.js runtime"
read_when:
  - Your deployment requires Node.js to run with FIPS mode enabled
  - You build OpenClaw on approved Node.js and OpenSSL images
  - You need runtime evidence without changing OpenClaw's default image
title: "FIPS runtime wiring"
---

# FIPS runtime wiring

OpenClaw does not ship or validate a cryptographic module. It can run on a
Node.js runtime whose OpenSSL provider is configured for FIPS mode, and it
provides wiring and runtime checks that let operators prove that boundary is
active.

This is deliberately not a deployment profile. The default OpenClaw image and
installation paths remain unchanged.

## Runtime contract

The operator owns:

- a supported Node.js build with an approved OpenSSL provider;
- the provider module, OpenSSL configuration, and startup flags;
- immutable build and runtime image digests;
- matching build/runtime libc and native-addon ABIs;
- platform evidence for the host or container runtime;
- the approved OpenClaw feature and plugin inventory.

FIPS mode must be active before the Node.js process starts. Node supports
provider configuration through an OpenSSL configuration file plus
`--enable-fips` or `--force-fips`. Depending on the Node.js distribution, the
startup environment commonly includes `OPENSSL_CONF`, `OPENSSL_MODULES`, and a
FIPS flag in `NODE_OPTIONS`. See the
[Node.js FIPS guidance](https://nodejs.org/docs/latest-v24.x/api/crypto.html#fips-mode)
for the upstream activation contract.

## Docker build target

The root `Dockerfile` includes an opt-in `fips-runtime` target. It assembles
OpenClaw on operator-supplied build and runtime images without embedding a
specific Linux distribution, package manager, provider module, or certificate.

```bash
docker build \
  --target fips-runtime \
  --build-arg OPENCLAW_FIPS_NODE_BUILD_IMAGE=registry.example/node-fips-build@sha256:<digest> \
  --build-arg OPENCLAW_FIPS_NODE_RUNTIME_IMAGE=registry.example/node-fips-runtime@sha256:<digest> \
  -t openclaw:fips .
```

The build image must provide Node.js, Corepack, and the compiler/toolchain
needed by selected native dependencies, and its build-only stage must support
UID 0. The runtime image must provide the same Node.js/OpenSSL ABI, trusted CA
roots, configured provider module, and intended runtime user.

The target reinstalls and prunes production dependencies in the supplied build
image. It does not copy native addons from the default OpenClaw build runtime.
This keeps native ABI and provider ownership with the operator-supplied image
pair. Platform and CPU selection remain explicit; libc selection is left to
the supplied build image and pnpm's runtime detection.

Use an init implementation supplied by the platform, such as
`docker run --init` or Compose `init: true`. The FIPS target does not assume
that a particular init binary or package manager exists in the runtime image.
It preserves the runtime image's configured user and clears any inherited
entrypoint before starting OpenClaw directly with Node.js. The `openclaw`
launcher remains available on `PATH`.

## Activate and verify

Mount the approved OpenSSL configuration and provider module into the final
container, then set the startup environment before Node launches:

```bash
docker run --rm --init \
  -e OPENSSL_CONF=/etc/ssl/fips/openssl.cnf \
  -e OPENSSL_MODULES=/usr/lib/ossl-modules \
  -e NODE_OPTIONS=--force-fips \
  -v /approved/openssl.cnf:/etc/ssl/fips/openssl.cnf:ro \
  -v /approved/ossl-modules:/usr/lib/ossl-modules:ro \
  openclaw:fips \
  node scripts/security/fips-check.mjs --json
```

The check exits nonzero unless `crypto.getFips()` is enabled and the required
Node cryptographic and TLS primitives work. It also reports startup wiring,
the optional host kernel indicator, legacy-provider exposure, and cryptography
that still needs separate inventory.

From a source checkout:

```bash
pnpm security:fips-check
```

A passing report is runtime evidence. It is not a FIPS validation or proof that
every enabled OpenClaw feature uses the same validated module.

## Managed services

Node startup configuration has to exist in the supervisor environment before
OpenClaw starts. OpenClaw-managed services intentionally do not preserve
arbitrary ambient `NODE_OPTIONS`, because preload and debugger flags cross a
code-execution boundary.

Prefer a Node distribution whose system configuration activates the provider.
Otherwise, add the approved OpenSSL variables and FIPS flag through a reviewed
systemd, launchd, container, or process-supervisor override. Run the FIPS check
inside that final service environment, not only from an interactive shell.

## TLS ownership

Gateway TLS uses Node's active OpenSSL runtime and requires TLS 1.3. Supply
operator-managed certificate and key files when the Gateway terminates TLS:

```json5
{
  gateway: {
    tls: {
      enabled: true,
      autoGenerate: false,
      certPath: "/etc/openclaw/tls/tls.crt",
      keyPath: "/etc/openclaw/tls/tls.key",
      caPath: "/etc/openclaw/tls/ca-bundle.crt",
    },
  },
}
```

`caPath` supplies a trust bundle; it does not by itself establish mutual TLS
client authentication. TLS may instead terminate at an approved ingress or
service proxy whose cryptographic boundary is documented separately.

## Cryptographic inventory

Node FIPS mode covers only operations routed through that Node/OpenSSL provider.
Inventory and disposition are still required for:

- device identity and browser WebCrypto;
- protocol-specific cryptography in plugins;
- native addons and downloaded native libraries;
- WASM cryptography;
- child processes and external tools;
- TLS terminated outside the Gateway process.

Do not infer coverage from algorithm names alone. A primitive being available
does not prove it was executed by the approved provider or inside the intended
module boundary.

## PQC

Post-quantum support is a separate protocol and migration decision. Do not add
experimental application-level PQC libraries merely because a Node/OpenSSL
runtime exposes new algorithms. Establish the protocol, interoperability,
provider validation, key lifecycle, and rollback plan at the owning boundary
first.

## Related

- [Docker](/install/docker)
- [Gateway TLS configuration](/gateway/configuration-reference#gatewaytls)
- [Secrets management](/gateway/secrets)
- [Security](/gateway/security)
- [OpenTelemetry](/gateway/opentelemetry)
