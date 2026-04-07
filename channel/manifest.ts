import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface Tool {
  name: string;
  source: 'project' | 'user' | 'global';
  command_hint: string;
  env_var_names: string[];
}

export interface Manifest {
  scanned_at: string;
  tools: Tool[];
}

function parseMcpJson(path: string, source: Tool['source']): Tool[] {
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const servers = raw.mcpServers ?? {};
    return Object.entries(servers).map(([name, config]: [string, any]) => ({
      name,
      source,
      command_hint: [config.command, ...(config.args ?? [])].join(' '),
      env_var_names: Object.keys(config.env ?? {}),
    }));
  } catch {
    return [];
  }
}

export function scanManifest(): Manifest {
  const tools: Tool[] = [
    ...parseMcpJson(join(process.cwd(), '.mcp.json'), 'project'),
    ...parseMcpJson(join(homedir(), '.claude', '.mcp.json'), 'user'),
  ];

  // Deduplicate by name (project takes precedence over user)
  const seen = new Set<string>();
  const deduped = tools.filter(t => {
    if (seen.has(t.name)) return false;
    seen.add(t.name);
    return true;
  });

  return { scanned_at: new Date().toISOString(), tools: deduped };
}

export function formatManifest(manifest: Manifest): string {
  if (manifest.tools.length === 0) return 'No MCP tools configured.';
  return manifest.tools
    .map(t => `- ${t.name} (${t.source}) — ${t.command_hint}`)
    .join('\n');
}
