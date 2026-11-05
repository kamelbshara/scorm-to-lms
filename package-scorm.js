import AdmZip from 'adm-zip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { readFileSync } from 'node:fs';
const connector = readFileSync(new URL('./connector.js', import.meta.url), 'utf8');
export function connectPackage(buffer, config) {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  if (entries.length > 5000) throw new Error('Package has too many files');
  let size = 0;
  for (const e of entries) {
    size += e.header.size;
    if (size > 150 * 1024 * 1024) throw new Error('Expanded package exceeds 150 MB');
    if (e.entryName.includes('\\') || e.entryName.startsWith('/') || e.entryName.split('/').includes('..')) throw new Error('Unsafe ZIP path');
  }
  const manifest = zip.getEntry('imsmanifest.xml');
  if (!manifest || manifest.header.size > 2 * 1024 * 1024) throw new Error('A root imsmanifest.xml is required');
  const xml = manifest.getData().toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid or unsupported manifest');
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true }).parse(xml);
  if (!String(parsed.manifest?.metadata?.schemaversion ?? '').includes('1.2')) throw new Error('Only SCORM 1.2 packages are supported');
  const resources = parsed.manifest?.resources?.resource;
  const scos = (Array.isArray(resources) ? resources : [resources]).filter(r => r?.['@_scormtype']?.toLowerCase() === 'sco');
  if (scos.length !== 1) throw new Error('This version supports exactly one SCO per ZIP');
  const launch = decodeURIComponent(String(scos[0]['@_href'] || '').split(/[?#]/)[0]).replace(/^\.\//, '');
  if (!/\.html?$/i.test(launch) || !zip.getEntry(launch)) throw new Error('SCO launch must be an HTML file inside the ZIP');
  let count = 0;
  const safeConfig = JSON.stringify(config).replace(/</g, '\\u003c');
  const script = `<script data-scorm-gradebook>(${connector})(${safeConfig});</script>`;
  for (const e of entries) {
    if (e.isDirectory || !/\.html?$/i.test(e.entryName)) continue;
    const html = e.getData().toString('utf8');
    if (html.includes('data-scorm-gradebook')) throw new Error('Already connected; upload the original package');
    zip.updateFile(e.entryName, Buffer.from(/<head\b[^>]*>/i.test(html) ? html.replace(/<head\b[^>]*>/i, m => m + script) : script + html));
    count++;
  }
  if (!count) throw new Error('No HTML content found');
  return zip.toBuffer();
}
