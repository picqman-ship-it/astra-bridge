#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadRemoteConfig } from '../dist/remote/config.js';
import { remoteToolNames } from '../dist/remote/policy.js';
import { VERSION } from '../dist/version.js';
// Verifies the INSTALLED service against THIS build. Read/write happens only in a throwaway
// directory inside the first root. No durable job is started here (that would be a real job on
// the owner's Mac); job survival is verified by the temp-only scripts/reliability-smoke.mjs.
// The report goes to docs/installed-service-verification-<version>.json; the 0.2.0 report stays.
const cfg = loadRemoteConfig();
const token = fs.readFileSync(cfg.tokenFile,'utf8').trim();
const url = new URL(`http://${cfg.host}:${cfg.port}/mcp`);
const text = r => r.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
const transport = new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${token}`}}});
const client = new Client({name:'installed-commander-verification',version:'1.0.0'});
const checks = [];
const check = (name,ok) => { checks.push({name,ok:Boolean(ok)}); console.log(ok?'PASS':'FAIL',name); assert(ok,name); };
const call = (name,args={}) => client.callTool({name,arguments:args});
const tmp = fs.mkdtempSync(path.join(cfg.roots[0],'.verification-'));
let pid;
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map(t=>t.name);
  check(`installed server version is ${VERSION}`,client.getServerVersion()?.version===VERSION);
  const expected=remoteToolNames(cfg.trustedTerminal,cfg.trustedGui).sort();
  check(`exactly ${expected.length} tools as configured (trustedTerminal=${cfg.trustedTerminal}, trustedGui=${cfg.trustedGui}); remote config changes hidden`,JSON.stringify([...tools].sort())===JSON.stringify(expected)&&!tools.includes('set_config_value'));
  const idem=(await client.listTools()).tools.filter(t=>'idempotencyKey' in (t.inputSchema.properties??{})).map(t=>t.name).sort();
  check('write_file/edit_block/move_file/create_directory accept idempotencyKey',['create_directory','edit_block','move_file','write_file'].every(n=>idem.includes(n)));
  const dupFile=path.join(tmp,'dup.txt'); const dupKey=`verify-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await call('write_file',{path:dupFile,content:'once\n',mode:'append',idempotencyKey:dupKey});
  const replay=await call('write_file',{path:dupFile,content:'once\n',mode:'append',idempotencyKey:dupKey});
  check('installed idempotent append is replayed, not repeated',text(replay).includes('NOT executed again')&&fs.readFileSync(dupFile,'utf8')==='once\n');
  const file=path.join(tmp,'proof.txt'); const nonce=`verified-${Date.now()}`;
  check('installed write_file',!(await call('write_file',{path:file,content:nonce})).isError);
  check('installed read_file',text(await call('read_file',{path:file})).includes(nonce));
  check('installed start_search',text(await call('start_search',{path:tmp,pattern:nonce,searchType:'content'})).includes('proof.txt'));
  const launched=await call('start_process',{command:'python3 -i -q',timeout_ms:5000});
  pid=Number(/PID (\d+)/.exec(text(launched))?.[1]); check('installed Python REPL',pid>0&&!launched.isError);
  check('installed REPL calculation',text(await call('interact_with_process',{pid,input:'value=6*7; print("answer=%d" % value)',timeout_ms:5000})).includes('answer=42'));
  const secondTransport=new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${token}`}},sessionId:transport.sessionId});
  const second=new Client({name:'installed-reconnect-verification',version:'1.0.0'});
  try {
    await second.connect(secondTransport);
    check('installed same-session reconnect',text(await second.callTool({name:'interact_with_process',arguments:{pid,input:'print("answer=%d" % (value+1))',timeout_ms:5000}})).includes('answer=43'));
  } finally { await second.close().catch(()=>{}); }
  check('installed clean REPL shutdown',!(await call('force_terminate',{pid})).isError); pid=undefined;
  console.log('SESSION_STATE',text(await call('list_sessions')));
} catch(error) { console.error('Verification failed:',error.message); process.exitCode=1;
} finally {
  if(pid) await call('force_terminate',{pid}).catch(()=>{});
  await transport.terminateSession().catch(()=>{}); await client.close().catch(()=>{});
  fs.rmSync(tmp,{recursive:true,force:true});
  const report={checkedAt:new Date().toISOString(),version:VERSION,ok:!process.exitCode,endpoint:url.toString(),checks};
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  fs.writeFileSync(path.join(root,'docs',`installed-service-verification-${VERSION}.json`),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log('INSTALLED_SERVICE_RESULT',JSON.stringify({ok:report.ok,passed:checks.filter(c=>c.ok).length,total:checks.length}));
}
