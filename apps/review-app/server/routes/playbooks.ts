// ---------------------------------------------------------------------------
// GET /api/playbooks — returns every bundled playbook so the /prompts page
// can render the prompt library. Bodies are small (one ~10KB file today),
// so a single response with the full set is fine.
// ---------------------------------------------------------------------------
import { Hono } from 'hono';
import type { Env } from '../types';
import { PLAYBOOKS } from '../playbooks';

const playbooks = new Hono<{ Bindings: Env }>();

playbooks.get('/', (c) =>
  c.json(
    PLAYBOOKS.map((p) => ({
      slug: p.slug,
      title: p.frontmatter.title,
      description: p.frontmatter.description,
      scope_label: p.frontmatter.scope_label,
      scope_placeholder: p.frontmatter.scope_placeholder,
      body: p.body,
    })),
  ),
);

export default playbooks;
