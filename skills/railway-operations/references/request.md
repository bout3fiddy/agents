# Request

Query Railway docs, GraphQL API, community threads, and templates.

## Official docs

Primary authoritative sources:

- Full API docs: `https://docs.railway.com/api/llms-docs.md`
- Summary: `https://railway.com/llms.txt`
- Templates: `https://railway.com/llms-templates.md`
- Changelog: `https://railway.com/llms-changelog.md`
- Blog: `https://blog.railway.com/llms-blog.md`

Tip: Append `.md` to any `docs.railway.com` URL for LLM-friendly markdown versions.

## Community (Central Station)

### Recent threads

```bash
curl -s 'https://station-server.railway.com/gql' \
  -H 'content-type: application/json' \
  -d '{"query":"{ threads(first: 10, sort: recent_activity) { edges { node { slug subject status upvoteCount createdAt topic { slug displayName } } } } }"}'
```

Filter by topic: `"questions"`, `"feedback"`, `"community"`, `"billing"`.
Sort options: `recent_activity` (default), `newest`, `highest_votes`.

### Search threads

```bash
curl -s 'https://station-server.railway.com/gql' \
  -H 'content-type: application/json' \
  -d '{"query":"{ threads(first: 10, search: \"<search-term>\") { edges { node { slug subject status } } } }"}'
```

### Bulk export

Retrieve all public threads with full content:

```bash
curl -s 'https://station-server.railway.com/api/llms-station'
```

### Read full thread

```bash
curl -s 'https://station-server.railway.com/api/threads/<slug>?format=md'
```

Thread URLs follow: `https://station.railway.com/{topic_slug}/{thread_slug}`

## GraphQL helper script

All GraphQL operations use an authentication-aware helper:

```bash
scripts/railway-api.sh '<query>' '<variables-json>'
```

The script reads credentials from `~/.railway/config.json` and sends requests to `https://backboard.railway.com/graphql/v2`.

## Project mutations

Update project settings (rename, PR deploys, visibility) unavailable in CLI:

```bash
scripts/railway-api.sh \
  'mutation updateProject($id: String!, $input: ProjectUpdateInput!) {
    projectUpdate(id: $id, input: $input) { id name isPublic prDeploys botPrEnvironments }
  }' \
  '{"id":"<project-id>","input":{"name":"new-name","prDeploys":true}}'
```

Common fields: `name`, `isPublic`, `prDeploys`, `botPrEnvironments`.

## Service mutations

Rename services or change icons (CLI-limited functionality):

```bash
scripts/railway-api.sh \
  'mutation updateService($id: String!, $input: ServiceUpdateInput!) {
    serviceUpdate(id: $id, input: $input) { id name icon }
  }' \
  '{"id":"<service-id>","input":{"name":"new-name"}}'
```

Icon values: image URLs, animated GIFs, or devicons like `https://devicons.railway.app/postgres`.

## Service creation

Programmatic service creation with GraphQL:

```bash
scripts/railway-api.sh \
  'mutation createService($input: ServiceCreateInput!) {
    serviceCreate(input: $input) { id name }
  }' \
  '{"input":{"projectId":"<project-id>","name":"my-service","source":{"image":"nginx:latest"}}}'
```

Input fields: `projectId` (required), `name`, `source.image`, `source.repo`, `branch`, `environmentId`.

After creation, apply JSON configuration including `isCreated: true`.

## Metrics queries

Resource usage metrics (CPU, memory, network, disk):

```bash
scripts/railway-api.sh \
  'query metrics($environmentId: String!, $serviceId: String, $startDate: DateTime!, $measurements: [MetricMeasurement!]!) {
    metrics(environmentId: $environmentId, serviceId: $serviceId, startDate: $startDate, measurements: $measurements) {
      measurement tags { serviceId deploymentId region } values { ts value }
    }
  }' \
  '{"environmentId":"<env-id>","serviceId":"<service-id>","startDate":"2026-02-19T00:00:00Z","measurements":["CPU_USAGE","MEMORY_USAGE_GB"]}'
```

Available measurements: `CPU_USAGE`, `CPU_LIMIT`, `MEMORY_USAGE_GB`, `MEMORY_LIMIT_GB`, `NETWORK_RX_GB`, `NETWORK_TX_GB`, `DISK_USAGE_GB`, `EPHEMERAL_DISK_USAGE_GB`, `BACKUP_USAGE_GB`.

Optional: `endDate`, `sampleRateSeconds`, `averagingWindowSeconds`. Use `groupBy: ["SERVICE_ID"]` to query all services simultaneously.

## Template search

Marketplace search:

```bash
scripts/railway-api.sh \
  'query templates($query: String!, $verified: Boolean) {
    templates(query: $query, verified: $verified) {
      edges { node { code name description category } }
    }
  }' \
  '{"query":"redis","verified":true}'
```

Common codes: `ghost`, `strapi`, `postgres`, `redis`, `mysql`, `mongodb`.

Deploy via CLI: `railway deploy --template <template-code>`

### GraphQL template deployment

Two-step flow for specific environments:

**Step 1** — Fetch configuration:

```bash
scripts/railway-api.sh \
  'query template($code: String!) {
    template(code: $code) { id serializedConfig }
  }' \
  '{"code":"postgres"}'
```

**Step 2** — Deploy:

```bash
scripts/railway-api.sh \
  'mutation deploy($input: TemplateDeployV2Input!) {
    templateDeployV2(input: $input) { projectId workflowId }
  }' \
  '{"input":{"templateId":"<id-from-step-1>","serializedConfig":<config-object>,"projectId":"<project-id>","environmentId":"<env-id>","workspaceId":"<workspace-id>"}}'
```

Note: `serializedConfig` is a raw JSON object, not a string.

## Validated against

- API documentation: https://docs.railway.com/api/llms-docs.md
- CLI source: https://github.com/railwayapp/cli/blob/a8a5afe/src/commands/docs.rs
