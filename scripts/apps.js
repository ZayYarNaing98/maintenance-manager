// Connects or disconnects an app Worker so the dashboard can offer it for domains.
// Service bindings are fixed at deploy time, so this runs from the terminal. Domains
// themselves are added and removed in the dashboard.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const usage = `Usage:
  npm run app:add -- <worker-name> [--deploy]
  npm run app:remove -- <worker-name> [--deploy]

Options:
  --config   Wrangler config to edit (default: wrangler.production.jsonc)
  --deploy   Run wrangler deploy after editing`;

function fail(message) {
  console.error(`${message}\n\n${usage}`);
  process.exit(1);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', default: 'wrangler.production.jsonc' },
      deploy: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
} catch (error) {
  fail(error.message);
}
const { values: options, positionals } = parsed;
if (options.help) {
  console.log(usage);
  process.exit(0);
}
const [command, worker] = positionals;
if (!['add', 'remove'].includes(command)) fail('Choose add or remove.');
if (!worker || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(worker)) fail('Give the app Worker name, such as blog-app.');

// Wrangler configs are JSONC. Strip comments outside strings and trailing commas.
function parseJsonc(text) {
  let output = '';
  let inString = false;
  let comments = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    const next = text[index + 1];
    if (inString) {
      output += character;
      if (character === '\\') output += text[++index];
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
      output += character;
    } else if (character === '/' && next === '/') {
      comments = true;
      while (index < text.length && text[index] !== '\n') index++;
      output += '\n';
    } else if (character === '/' && next === '*') {
      comments = true;
      const end = text.indexOf('*/', index + 2);
      if (end === -1) throw new Error('Unclosed block comment.');
      index = end + 1;
    } else {
      output += character;
    }
  }
  return { config: JSON.parse(output.replace(/,(\s*[}\]])/g, '$1')), comments };
}

let source;
try {
  source = readFileSync(options.config, 'utf8');
} catch {
  fail(`Cannot read ${options.config}. Copy wrangler.production.example.jsonc first.`);
}
const { config, comments } = parseJsonc(source);
config.services ??= [];
config.vars ??= {};
config.vars.APPS ??= [];

if (command === 'add') {
  if (config.vars.APPS.some((app) => app.worker === worker)) fail(`${worker} is already connected.`);
  const base = worker.replace(/[^a-z0-9]/g, '_').toUpperCase();
  const binding = base.endsWith('_APP') ? base : `${base}_APP`;
  if (config.services.some((service) => service.binding === binding)) fail(`The binding ${binding} already exists.`);
  config.services.push({ binding, service: worker });
  config.vars.APPS.push({ binding, worker });
  console.log(`Connected ${worker} as ${binding}. After deploying, choose it in the dashboard's Add domain form.`);
} else {
  const app = config.vars.APPS.find((item) => item.worker === worker);
  if (!app) fail(`${worker} is not connected in ${options.config}.`);
  const seeded = (config.vars.DOMAINS ?? []).filter((domain) => domain.service === app.binding).map((domain) => domain.hostname);
  config.vars.APPS = config.vars.APPS.filter((item) => item !== app);
  config.services = config.services.filter((service) => service.binding !== app.binding);
  console.log(`Disconnected ${worker}. Remove its domains in the dashboard first; after deploying, any domain still using it returns 503.`);
  if (seeded.length) console.log(`Note: DOMAINS still lists ${seeded.join(', ')} with this app. That list only seeds a new registry.`);
}

writeFileSync(options.config, `${JSON.stringify(config, null, 2)}\n`);
if (comments) console.log(`\nNote: comments in ${options.config} were removed when it was rewritten.`);

if (options.deploy) {
  const result = spawnSync('npx', ['wrangler', 'deploy', '--config', options.config], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
console.log(`\nDeploy with: npx wrangler deploy --config ${options.config}`);
