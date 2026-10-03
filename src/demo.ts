import { resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { openDb } from './db';
import { LifeService } from './service';
import { Cell } from './core';

const dbPath = resolve(process.cwd(), 'data', 'demo.db');
rmSync(dbPath, { force: true });
rmSync(dbPath + '-wal', { force: true });
rmSync(dbPath + '-shm', { force: true });

function banner(t: string) {
  process.stdout.write('\n' + '='.repeat(64) + '\n' + t + '\n' + '='.repeat(64) + '\n');
}

function showGenerations(svc: LifeService, runId: number, upto: number, title: string) {
  process.stdout.write(`\n--- ${title} ---\n`);
  for (let g = 0; g <= upto; g++) {
    const snap = svc.getGeneration(runId, g);
    process.stdout.write(`\n[第 ${g} 代] 人口=${snap.population}\n`);
    process.stdout.write(svc.renderGeneration(runId, g) + '\n');
    if (g > 0) {
      const d = snap.diff;
      const fmt = (cs: Cell[]) => cs.map((c) => `(${c.x},${c.y})`).join(' ') || '-';
      process.stdout.write(`  存活: ${fmt(d.survived)}\n`);
      process.stdout.write(`  出生: ${fmt(d.born)}\n`);
      process.stdout.write(`  死亡: ${fmt(d.died)}\n`);
    }
  }
}

function main() {
  banner('1. 稳定方块（block）—— 周期 1 固定点');
  const db = openDb(dbPath);
  const svc = new LifeService(db);
  const block = svc.createBoard({
    name: 'block',
    width: 6,
    height: 6,
    boundary: 'fixed',
    alive: [
      { x: 1, y: 1 }, { x: 2, y: 1 },
      { x: 1, y: 2 }, { x: 2, y: 2 },
    ],
  });
  const blockRun = svc.runEvolution(block.id, 2);
  showGenerations(svc, blockRun.id, 2, '方块应保持不变');
  process.stdout.write(`周期检测: ${JSON.stringify(blockRun.cycle)}（firstSeen=0, period=1）\n`);

  banner('2. 闪烁子（blinker）—— 周期 2');
  const blinker = svc.createBoard({
    name: 'blinker',
    width: 5,
    height: 5,
    boundary: 'fixed',
    alive: [{ x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }],
  });
  const blinkerRun = svc.runEvolution(blinker.id, 4);
  showGenerations(svc, blinkerRun.id, 4, '横条 ⇄ 竖条');
  process.stdout.write(`周期检测: ${JSON.stringify(blinkerRun.cycle)}（firstSeen=0, period=2）\n`);

  banner('3. 滑翔机（glider）—— 会平移，形状相同但位置不同，不算重复');
  const glider = svc.createBoard({
    name: 'glider',
    width: 10,
    height: 10,
    boundary: 'fixed',
    alive: [
      { x: 1, y: 0 },
      { x: 2, y: 1 },
      { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 },
    ],
  });
  const gliderRun = svc.runEvolution(glider.id, 12);
  showGenerations(svc, gliderRun.id, 12, '滑翔机向右下移动（在固定边界内）');
  process.stdout.write(`周期检测（平移不算重复）: ${JSON.stringify(gliderRun.cycle)}\n`);

  banner('4. 同一边缘布局：固定死边界 vs 环面边界');
  // 贴在顶边的横三格：固定边界外侧视为死，环面下顶边与底边互为邻居
  const edgeLayout: Cell[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
  const fixedB = svc.createBoard({ name: 'edge-fixed', width: 5, height: 5, boundary: 'fixed', alive: edgeLayout });
  const torusB = svc.createBoard({ name: 'edge-torus', width: 5, height: 5, boundary: 'torus', alive: edgeLayout });
  const fixedRun = svc.runEvolution(fixedB.id, 1);
  const torusRun = svc.runEvolution(torusB.id, 1);
  process.stdout.write('\n[fixed] 第 1 代:\n' + svc.renderGeneration(fixedRun.id, 1) + '\n');
  process.stdout.write('[torus] 第 1 代（左右/上下首尾相连）:\n' + svc.renderGeneration(torusRun.id, 1) + '\n');
  process.stdout.write(
    `固定边界人口=${svc.getGeneration(fixedRun.id, 1).population}，` +
      `环面边界人口=${svc.getGeneration(torusRun.id, 1).population}\n`,
  );

  banner('5. 重复坐标提示 & 全死棋盘');
  const dup = svc.createBoard({
    name: 'duplicates',
    width: 4,
    height: 4,
    boundary: 'fixed',
    alive: [
      { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 1 },
    ],
  });
  process.stdout.write(`重复活点数量 duplicates=${dup.versions[0].duplicates}，去重后活点=${dup.versions[0].alive.length}\n`);
  const dead = svc.createBoard({ name: 'all-dead', width: 3, height: 3, boundary: 'fixed', alive: [] });
  const deadRun = svc.runEvolution(dead.id, 2);
  process.stdout.write('\n[全死] 第 2 代:\n' + svc.renderGeneration(deadRun.id, 2) + '\n');
  process.stdout.write(`全死棋盘周期: ${JSON.stringify(deadRun.cycle)}（firstSeen=0, period=1）\n`);

  db.close();

  banner('6. 服务重启后读取历史代数（重新打开数据库）');
  const db2 = openDb(dbPath);
  const svc2 = new LifeService(db2);
  const runs = svc2.listRuns();
  process.stdout.write(`重启后共读到 ${runs.length} 次运行\n`);
  const restored = svc2.getRun(blinkerRun.id);
  const g3 = svc2.getGeneration(blinkerRun.id, 3);
  process.stdout.write(`闪烁子运行 cycle=${JSON.stringify(restored.cycle)}\n`);
  process.stdout.write(`第 3 代人口=${g3.population}，活点=${JSON.stringify(g3.alive)}\n`);
  process.stdout.write('\n' + svc2.renderGeneration(blinkerRun.id, 3) + '\n');
  db2.close();

  process.stdout.write('\n演示完成。数据库文件: ' + dbPath + '\n');
}

main();
