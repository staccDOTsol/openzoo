/** Pin find(1) to the thread cwd. Unbounded `find /` is a full-disk walk. */
import path from 'node:path';

export const FIND_MAXDEPTH = Number(process.env.OZ_FIND_MAXDEPTH || 8);

export function guardFindCwd(command, cwd = '.') {
  if (typeof command !== 'string' || !command) return command;
  if (!/(?:^|[\s;|&(`])find(?:\s|$)/.test(command)) return command;
  const root = path.resolve(cwd || '.');
  return command.replace(/(^|[\s;|&(`])((?:sudo\s+)?)find(\s+)([^;&|`\n]*)/g, (m, pre, sudo, sp, args) => {
    const tokens = args.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    const paths = [];
    let i = 0;
    while (i < tokens.length && !String(tokens[i]).startsWith('-')) {
      paths.push(tokens[i]);
      i++;
    }
    const rest = tokens.slice(i);
    const hasMax = rest.some((t) => t === '-maxdepth');
    const pin = (raw) => {
      const unquoted = String(raw).replace(/^['"]|['"]$/g, '');
      if (!unquoted || unquoted === '.' || unquoted === './') return '.';
      const abs = path.resolve(root, unquoted);
      const inside = abs === root || abs.startsWith(root + path.sep);
      return inside ? raw : '.';
    };
    const newPaths = (paths.length ? paths.map(pin) : ['.']);
    const depth = hasMax ? [] : ['-maxdepth', String(FIND_MAXDEPTH)];
    return `${pre}${sudo}find${sp}${[...newPaths, ...depth, ...rest].join(' ')}`;
  });
}
