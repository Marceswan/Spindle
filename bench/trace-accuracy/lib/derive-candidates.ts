// Text candidates are inputs for human adjudication, not graph truth.
import { spawnSync } from 'node:child_process';

export type Candidate = { line: number; text: string };
export function classifyFile(path: string): { surface: string; spindleCovers: boolean; reason?: string } {
  const p = path.replaceAll('\\', '/');
  const kinds: [RegExp, string][] = [
    [/\.cls$/, 'apex-class'], [/\.trigger$/, 'apex-trigger'],
    [/\/lwc\//, 'lwc'], [/\/aura\//, 'aura'], [/\.page$/, 'vf-page'], [/\.component$/, 'vf-component'],
    [/\.field-meta\.xml$/, 'field-meta'], [/\.object-meta\.xml$/, 'sobject-meta'],
    [/\.validationRule-meta\.xml$/, 'validation-rule'], [/\.permissionset-meta\.xml$/, 'permission-set'],
    [/\.permissionsetgroup-meta\.xml$/, 'permission-set-group'], [/\.profile-meta\.xml$/, 'profile'],
    [/\.flexipage-meta\.xml$/, 'flexipage'], [/\.layout-meta\.xml$/, 'layout'], [/\.flow-meta\.xml$/, 'flow'],
    [/\.email-meta\.xml$/, 'email-template'], [/\.labels-meta\.xml$/, 'custom-labels'], [/\.resource-meta\.xml$/, 'static-resource'],
  ];
  const match = kinds.find(([pattern]) => pattern.test(p));
  return match ? { surface: match[1], spindleCovers: true } : { surface: 'other', spindleCovers: false, reason: 'unmodeled file type' };
}
export async function deriveCandidates(apiName: string, root: string): Promise<Map<string, Candidate[]>> {
  const leaf = apiName.split('.').at(-1) ?? apiName;
  if (!leaf) throw new Error('A nonempty API name is required');
  const result = spawnSync('rg', ['--json', '--fixed-strings', '--', leaf, root], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) throw new Error(result.stderr || 'ripgrep failed');
  const grouped = new Map<string, Candidate[]>();
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const event = JSON.parse(line) as {type:string;data:{path:{text:string};line_number:number;lines:{text:string}}};
    if (event.type !== 'match') continue;
    const { path, line_number, lines } = event.data;
    const entries = grouped.get(path.text) ?? [];
    entries.push({ line: line_number, text: lines.text.trimEnd() });
    grouped.set(path.text, entries);
  }
  return grouped;
}
