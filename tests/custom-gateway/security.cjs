/**
 * Security regression: the trusted-host allowlist must NOT weaken SSRF
 * protection for anything the operator did not explicitly vouch for, and must
 * preserve the exact URL path in gateway mode.
 */
const path = require("node:path");
const BUILD = path.join(process.env.MB_ROOT || path.join(__dirname, "../.."), process.env.MB_BUILD_DIR || ".btest");
const Module = require("node:module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request.startsWith("@/lib/")) request = path.join(BUILD, request.slice("@/lib/".length));
  else if (request.startsWith("@/")) request = path.join(BUILD, request.slice(2));
  return origResolve.call(this, request, parent, ...rest);
};

const guard = require(path.join(BUILD, "ai/providers/customApiGuard.js"));

let fail = 0;
const pass = (label) => console.log(`PASS  ${label}`);
const bad = (label, detail) => {
  console.log(`FAIL  ${label} -- ${detail}`);
  fail++;
};

async function mustReject(label, url, opts) {
  try {
    await guard.resolveCustomApiTarget(url, opts);
    bad(label, "expected rejection but resolved");
  } catch (e) {
    pass(`${label} -> ${e.message.slice(0, 62)}`);
  }
}

async function mustResolve(label, url, opts, expectPath) {
  try {
    const t = await guard.resolveCustomApiTarget(url, opts);
    if (expectPath && t.url.pathname !== expectPath) {
      bad(label, `path ${t.url.pathname} != ${expectPath}`);
      return;
    }
    pass(`${label} -> ${t.url.pathname}`);
  } catch (e) {
    bad(label, e.message);
  }
}

(async () => {
  console.log("=== SSRF must still be blocked ===\n");
  delete process.env.CUSTOM_API_TRUSTED_HOSTS;

  await mustReject("localhost", "http://localhost:8080/v1", { exactPath: true });
  await mustReject("127.0.0.1", "http://127.0.0.1/api/plan/v3", { exactPath: true });
  await mustReject("10.x private", "http://10.0.0.5/api/plan/v3", { exactPath: true });
  await mustReject("192.168.x private", "http://192.168.1.1/v1", { exactPath: true });
  await mustReject("169.254 link-local", "http://169.254.169.254/latest/meta-data", { exactPath: true });
  await mustReject("172.16 private", "http://172.16.0.1/v1", { exactPath: true });
  await mustReject("::1 loopback", "http://[::1]/v1", { exactPath: true });
  await mustReject("embedded creds", "https://user:pw@example.com/api/plan/v3", { exactPath: true });
  await mustReject("*.local mdns", "http://printer.local/v1", { exactPath: true });
  await mustReject("bad scheme", "ftp://example.com/v1", { exactPath: true });
  await mustReject("ipv4-mapped ipv6 loopback", "http://[::ffff:127.0.0.1]/v1", { exactPath: true });

  console.log("\n=== allowlist must be scoped (does not blanket-allow) ===\n");
  process.env.CUSTOM_API_TRUSTED_HOSTS = "ark.cn-beijing.volces.com";
  // A trusted entry for one host must not let a DIFFERENT host reach private space.
  await mustReject("untrusted host -> private IP still blocked", "http://10.1.2.3/api/plan/v3", {
    exactPath: true,
  });
  await mustReject("localhost still blocked with allowlist set", "http://localhost/v1", {
    exactPath: true,
  });

  console.log("\n=== exact path preservation (gateway mode) ===\n");
  await mustResolve(
    "plan/v3 preserved verbatim",
    "https://ark.cn-beijing.volces.com/api/plan/v3",
    { exactPath: true },
    "/api/plan/v3/chat/completions",
  );
  await mustResolve(
    "full URL kept as-is",
    "https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions",
    { exactPath: true },
    "/api/plan/v3/chat/completions",
  );
  await mustResolve(
    "trailing slash tolerated",
    "https://ark.cn-beijing.volces.com/api/plan/v3/",
    { exactPath: true },
    "/api/plan/v3/chat/completions",
  );

  console.log("\n=== legacy mode still injects /v1 (unchanged behaviour) ===\n");
  await mustResolve(
    "legacy adds /v1",
    "https://ark.cn-beijing.volces.com/api",
    undefined,
    "/api/v1/chat/completions",
  );

  console.log("\n=== SSRF guard still applies to configured-provider endpoints ===\n");

  // The endpoint/appendV1 resolution path added for multi-provider support must
  // not become an SSRF bypass: every rejection that holds for the legacy path
  // has to hold here too.
  delete process.env.CUSTOM_API_TRUSTED_HOSTS;

  await mustReject("localhost via endpoint kind", "http://localhost:8080", {
    endpoint: "chat_completions",
    appendV1: true,
  });
  await mustReject("127.0.0.1 via endpoint kind", "http://127.0.0.1", {
    endpoint: "messages",
    appendV1: true,
  });
  await mustReject("10.x private via endpoint kind", "http://10.0.0.5", {
    endpoint: "responses",
    appendV1: true,
  });
  await mustReject("169.254 metadata via endpoint kind", "http://169.254.169.254", {
    endpoint: "models",
    appendV1: true,
  });
  await mustReject("embedded creds via endpoint kind", "https://u:p@example.com", {
    endpoint: "chat_completions",
    appendV1: true,
  });
  await mustReject("bad scheme via endpoint kind", "ftp://example.com", {
    endpoint: "chat_completions",
    appendV1: false,
  });
  await mustReject("mdns .local via endpoint kind", "http://box.local", {
    endpoint: "chat_completions",
    appendV1: true,
  });
  await mustReject("ipv4-mapped ipv6 loopback via endpoint kind", "http://[::ffff:127.0.0.1]", {
    endpoint: "chat_completions",
    appendV1: true,
  });

  console.log("\n=== endpoint construction is honoured, not guessed ===\n");

  const expectPath = (label, baseUrl, endpoint, appendV1, expected) => {
    let actual;
    try {
      actual = guard.buildProviderEndpointUrl({ baseUrl, endpoint, appendV1 }).pathname;
    } catch (e) {
      bad(label, e.message);
      return;
    }
    if (actual === expected) pass(`${label} -> ${actual}`);
    else bad(label, `${actual} != ${expected}`);
  };

  expectPath(
    "appendV1=false keeps plan/v3 verbatim",
    "https://example.com/api/plan/v3",
    "chat_completions",
    false,
    "/api/plan/v3/chat/completions",
  );
  expectPath(
    "appendV1=true injects /v1",
    "https://example.com",
    "chat_completions",
    true,
    "/v1/chat/completions",
  );
  expectPath(
    "appendV1=true never doubles /v1",
    "https://example.com/v1",
    "chat_completions",
    true,
    "/v1/chat/completions",
  );
  expectPath(
    "anthropic messages endpoint",
    "https://example.com",
    "messages",
    true,
    "/v1/messages",
  );
  expectPath(
    "models endpoint rebases off a chat URL",
    "https://example.com/v1/chat/completions",
    "models",
    true,
    "/v1/models",
  );

  console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
})();
