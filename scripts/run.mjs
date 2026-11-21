#!/usr/bin/env node
/**
 * Jack 五平台发布快速通道 CLI（Fast Path Runner）
 *
 * 用法：
 *   node scripts/run.mjs --job /abs/path/job.json --stage pass1 [--platforms xhs,douyin,bilibili,wechat,x]
 *   node scripts/run.mjs --job /abs/path/job.json --stage pass2 [--platforms wechat,x]
 *   node scripts/run.mjs --job /abs/path/job.json --stage finish
 *   node scripts/run.mjs --job /abs/path/job.json --dry-run
 *   node scripts/run.mjs --stage offline
 *
 * 设计理念：
 * - 脚本是「快速通道」，不是刚性黑盒；五平台彼此 try/catch 隔离。
 * - 若某平台因前端改版、未知弹窗或验收红灯返回 needs_agent_fallback，
 *   保留现场标签页，由 Agent 自主接管修补该平台，其余绿灯平台不受影响。
 * - 任何情况下绝不点击最终发布或定时发布按钮。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateAndNormalizeJob } from "./lib/validate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = { stage: "pass1", dryRun: false, platforms: null, jobPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--job" && argv[i + 1]) args.jobPath = path.resolve(argv[++i]);
    else if (a === "--stage" && argv[i + 1]) args.stage = argv[++i];
    else if (a === "--platforms" && argv[i + 1]) {
      args.platforms = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        [
          "Usage:",
          "  node scripts/run.mjs --job <job.json> --stage <pass1|pass2|finish> [--platforms xhs,douyin,bilibili,wechat,x]",
          "  node scripts/run.mjs --job <job.json> --dry-run",
          "  node scripts/run.mjs --stage offline",
        ].join("\n")
      );
      process.exit(0);
    }
  }
  return args;
}

function runEgoScript(scriptSource) {
  const res = spawnSync("ego-browser", ["nodejs"], {
    input: scriptSource,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) {
    throw new Error(`启动 ego-browser 失败: ${res.error.message}`);
  }
  return res;
}

function extractResultJson(res) {
  const combined = `${res.stdout || ""}\n${res.stderr || ""}`;
  const startMarker = "__JACK_PUBLISHER_START__";
  const endMarker = "__JACK_PUBLISHER_END__";
  const sIdx = combined.lastIndexOf(startMarker);
  if (sIdx < 0) return null;
  const eIdx = combined.indexOf(endMarker, sIdx + startMarker.length);
  const slice = eIdx > sIdx
    ? combined.slice(sIdx + startMarker.length, eIdx).trim()
    : combined.slice(sIdx + startMarker.length).trim();
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const validStages = ["pass1", "pass2", "finish", "offline"];
  if (!validStages.includes(args.stage)) {
    console.error(`不支持的 --stage "${args.stage}"，可选: ${validStages.join(", ")}`);
    process.exit(2);
  }

  const runnerUrl = pathToFileURL(path.join(__dirname, "lib", "runner.mjs")).href;

  if (args.stage === "offline") {
    const payload = { stage: "offline", skillRoot: SKILL_ROOT };
    const egoCode = `
const mod = await import(${JSON.stringify(runnerUrl)});
const result = await mod.runStage(
  { taskSpace, listTaskSpaces, claimTaskSpace, takeOverTaskSpace },
  ${JSON.stringify(payload)}
);
console.log("__JACK_PUBLISHER_START__" + JSON.stringify(result) + "__JACK_PUBLISHER_END__");
`;
    const res = runEgoScript(egoCode);
    const parsed = extractResultJson(res);
    if (parsed) {
      console.log(JSON.stringify(parsed, null, 2));
      process.exit(parsed.ok ? 0 : 1);
    }
    console.error(res.stdout || "");
    console.error(res.stderr || "");
    process.exit(res.status || 1);
  }

  if (!args.jobPath) {
    console.error("缺少必填参数 --job <path/to/job.json>");
    process.exit(2);
  }
  if (!fs.existsSync(args.jobPath)) {
    console.error(`任务配置文件不存在: ${args.jobPath}`);
    process.exit(2);
  }

  const rawJob = JSON.parse(fs.readFileSync(args.jobPath, "utf-8"));
  if (args.platforms?.length) {
    rawJob.platforms = args.platforms;
  }

  const normalized = validateAndNormalizeJob(rawJob);

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          stage: args.stage,
          jobPath: args.jobPath,
          normalized,
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  const payload = {
    stage: args.stage,
    skillRoot: SKILL_ROOT,
    jobPath: args.jobPath,
    job: normalized,
  };

  const egoCode = `
const mod = await import(${JSON.stringify(runnerUrl)});
const result = await mod.runStage(
  { taskSpace, listTaskSpaces, claimTaskSpace, takeOverTaskSpace },
  ${JSON.stringify(payload)}
);
console.log("__JACK_PUBLISHER_START__" + JSON.stringify(result) + "__JACK_PUBLISHER_END__");
`;

  const res = runEgoScript(egoCode);
  const parsed = extractResultJson(res);

  // 自动回写 spaceId 与 pageLabels 到 job.json，方便 pass2 / finish 与 Agent 接管
  if (parsed && parsed.spaceId != null && args.stage !== "finish") {
    try {
      const updated = JSON.parse(fs.readFileSync(args.jobPath, "utf-8"));
      updated.spaceId = parsed.spaceId;
      if (parsed.pageLabels && Object.keys(parsed.pageLabels).length) {
        updated.pageLabels = { ...(updated.pageLabels || {}), ...parsed.pageLabels };
      }
      fs.writeFileSync(args.jobPath, JSON.stringify(updated, null, 2) + "\n", "utf-8");
    } catch (e) {
      parsed.jobSyncWarning = e.message;
    }
  }

  if (parsed) {
    console.log(JSON.stringify(parsed, null, 2));
    process.exit(0);
  }

  // 脚本异常崩溃时如实透传输出，交由 Agent 诊断接管
  console.log(
    JSON.stringify(
      {
        stage: args.stage,
        status: "needs_agent_fallback",
        reason: "ego-browser script exited without structured result",
        exitCode: res.status,
        stdoutTail: (res.stdout || "").slice(-1200),
        stderrTail: (res.stderr || "").slice(-1200),
      },
      null,
      2
    )
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      {
        status: "validation_or_runner_error",
        message: err.message,
        validationErrors: err.validationErrors || undefined,
      },
      null,
      2
    )
  );
  process.exit(2);
});
