"use client";

import { Badge, CodeBlock, PageHeader, Panel } from "@/components/ui";

export default function Identity() {
  return (
    <>
      <PageHeader title="Identity & access" description="Human, API client, workload, agent and MCP client identities are kept separate." />
      <div className="space-y-5">
        <Panel title="Sign-in" actions={<Badge tone="warn">development mode</Badge>}>
          <p className="text-sm text-ink-2">You are signed in as a local platform administrator. For shared environments, federate identity through OIDC or SAML (for example Keycloak, Entra ID or Okta) and provision users with SCIM.</p>
          <div className="mt-3"><CodeBlock code={`# services/control-plane/.env\nAPF_OIDC_ISSUER=https://idp.example.com/realms/apification\nAPF_OIDC_CLIENT_ID=apification-console\nAPF_OIDC_AUDIENCE=apification`} /></div>
          <p className="mt-2 text-2xs text-ink-4">OIDC wiring is the next milestone; the management API already separates the current user from API client identities.</p>
        </Panel>
        <Panel title="Identity types">
          <table className="tbl"><thead><tr><th>Type</th><th>Used for</th><th>Managed in</th></tr></thead>
            <tbody>
              <tr><td>Human users</td><td>Designing, approving, operating</td><td>Identity provider</td></tr>
              <tr><td>API clients</td><td>Calling published REST and GraphQL APIs</td><td>Security → API clients</td></tr>
              <tr><td>MCP clients</td><td>AI agents calling MCP tools</td><td>Security → API clients (kind: MCP client)</td></tr>
              <tr><td>Agent identities</td><td>Platform agents with explicit tool allowlists</td><td>Agentic Workspace</td></tr>
              <tr><td>Workload identities</td><td>Runtime access to vault secrets</td><td>Deployment platform</td></tr>
            </tbody></table>
        </Panel>
      </div>
    </>
  );
}
