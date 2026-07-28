/** Canonical identity classes delivered by the substrate seed graph.
 *
 * Identity-specific Net operations use these roots as actual lineage
 * witnesses. Keeping them in a neutral contract module avoids coupling one
 * Durable Object shell to another and prevents property-shaped classes from
 * impersonating accounts, humans, or agents. */
export const NET_ACCOUNT_CLASS = "$account";
export const NET_HUMAN_CLASS = "$human";
export const NET_AGENT_CLASS = "$agent";
