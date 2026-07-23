import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { analyzePullRequestDiff, pullRequestReportToSarif } from '../src/ide/prSecurityAgent.js';

const base = argument('--base') || process.env.GITHUB_BASE_SHA || '';
const head = argument('--head') || process.env.GITHUB_SHA || 'HEAD';
const output = resolve(argument('--output') || 'artifacts/pr-security');
const enforce = process.argv.includes('--enforce');
const range = base ? `${base}...${head}` : `${head}^...${head}`;
const { stdout: diff } = await execa('git', ['diff', '--no-ext-diff', '--unified=3', range], {
  maxBuffer: 12 * 1024 * 1024,
});
const report = analyzePullRequestDiff(diff);
await mkdir(output, { recursive: true });
await Promise.all([
  writeFile(resolve(output, 'hawk-pr-security.json'), `${JSON.stringify(report, null, 2)}\n`),
  writeFile(
    resolve(output, 'hawk-pr-security.sarif'),
    `${JSON.stringify(pullRequestReportToSarif(report), null, 2)}\n`,
  ),
  writeFile(resolve(output, 'hawk-pr-security.md'), markdown(report)),
]);
process.stdout.write(
  `${JSON.stringify({ range, output, gate: report.gate, findings: report.findings.length })}\n`,
);
if (enforce && report.gate === 'block') process.exitCode = 2;

function markdown(report: ReturnType<typeof analyzePullRequestDiff>): string {
  const rows = report.findings.length
    ? report.findings
        .map(
          (finding) =>
            `| ${finding.severity} | ${finding.ruleId} | ${finding.file}:${finding.line} | ${finding.title} |`,
        )
        .join('\n')
    : '| - | - | - | No deterministic diff signals |';
  return `# Hawk PR Security Agent\n\nGate: **${report.gate.toUpperCase()}**\n\n| Severity | Rule | Location | Signal |\n| --- | --- | --- | --- |\n${rows}\n\n${report.statement}\n`;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
