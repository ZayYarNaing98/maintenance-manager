using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "gateway", worker = (
      compatibilityDate = "2026-07-08",
      modules = [
        (name = "worker.js", esModule = embed "../src/worker.js"),
        (name = "domain-policy.js", esModule = embed "../src/domain-policy.js"),
        (name = "policy.js", esModule = embed "../src/policy.js"),
        (name = "ip.js", esModule = embed "../src/ip.js"),
        (name = "cloudflare.js", esModule = embed "../src/cloudflare.js"),
        (name = "domain-registry.js", esModule = embed "../src/domain-registry.js")
      ],
      durableObjectNamespaces = [
        (className = "DomainPolicy", uniqueKey = "maintenance-manager-test", enableSql = true),
        (className = "DomainRegistry", uniqueKey = "maintenance-manager-registry-test", enableSql = true)
      ],
      durableObjectStorage = (localDisk = "state"),
      bindings = [
        (name = "POLICIES", durableObjectNamespace = "DomainPolicy"),
        (name = "REGISTRY", durableObjectNamespace = "DomainRegistry"),
        (name = "CLOUDFLARE_API", service = "cloudflare"),
        (name = "CLOUDFLARE_API_TOKEN", text = "test-cf-token"),
        (name = "WORKER_NAME", text = "maintenance-manager-test"),
        (name = "ZONES", json = "[\"example.test\"]"),
        (name = "ADMIN_HOST", text = "admin.example.test"),
        (name = "ADMIN_BASIC", text = "operator:test-admin"),
        (name = "APP_BASIC", text = "preview:test-app"),
        (name = "RELEASE_DOMAIN", text = "app.example.test"),
        (name = "RELEASE_TOKEN", text = "test-release"),
        (name = "DOMAINS", json = "[{\"hostname\":\"app.example.test\",\"preview\":\"preview.example.test\",\"aliases\":[\"www.app.example.test\"],\"service\":\"APP\",\"credential\":\"APP_BASIC\"},{\"hostname\":\"other.example.test\",\"service\":\"APP\",\"credential\":\"OTHER_BASIC\"}]"),
        (name = "APP", service = "upstream"),
        (name = "ASSETS", service = "assets")
      ]
    )),
    (name = "state", disk = (writable = true)),
    (name = "upstream", worker = (
      compatibilityDate = "2026-07-08",
      modules = [(name = "upstream.js", esModule = embed "upstream.js")]
    )),
    (name = "assets", worker = (
      compatibilityDate = "2026-07-08",
      modules = [
        (name = "assets.js", esModule = "import html from './index.html'; export default { fetch: () => new Response(html, {headers: {'Content-Type': 'text/html'}}) };"),
        (name = "index.html", text = embed "../public/index.html")
      ]
    )),
    (name = "cloudflare", worker = (
      compatibilityDate = "2026-07-08",
      modules = [(name = "cloudflare.js", esModule = embed "cloudflare.js")]
    )),
    (name = "tests", worker = (
      compatibilityDate = "2026-07-08",
      modules = [(name = "gateway.js", esModule = embed "gateway.js")],
      bindings = [(name = "GATEWAY", service = "gateway"), (name = "CLOUDFLARE", service = "cloudflare")]
    ))
  ]
);
