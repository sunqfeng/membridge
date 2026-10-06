import { doctor } from './doctor';
import { diagnostic } from './diagnostics';

async function main() {
  switch (process.argv[2]) {
    case 'mcp': { const { startMcp } = await import('./mcp'); return startMcp(); }
    case 'doctor': {
      const report = await doctor();
      for (const check of report.checks) console.log(`${check.status}: ${check.code}`);
      if (report.codexConfig) console.log('\nCodex (TOML):\n' + report.codexConfig);
      if (report.claudeConfig) console.log('\nMCP client (JSON):\n' + JSON.stringify(report.claudeConfig, null, 2));
      console.error('MCP credentials inherit MEMBRIDGE_TOKEN from the launching environment; the token is omitted from this report.');
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    default: console.error('Usage: bun src/cli.ts <mcp|doctor>'); process.exitCode = 2;
  }
}
if (import.meta.main) main().catch(error => { diagnostic('MemBridge command failed', error); process.exitCode = 1; });
