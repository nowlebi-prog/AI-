import { createApp } from './app.ts';
import { VERSION } from './app-context.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
if (!config.password) {
  console.warn('⚠️  HUB_PASSWORD가 설정되지 않았어요. 설정하기 전에는 로그인할 수 없어요.');
}

const app = createApp(config);
app.server.listen(config.port, config.host, () => {
  console.log(`Hub ${VERSION} 실행 중 → http://localhost:${config.port}`);
  console.log(`  공개 주소: ${config.publicUrl || '(HUB_PUBLIC_URL 미설정 — 요청 헤더로 추정)'}`);
  console.log(`  MCP 엔드포인트: ${(config.publicUrl || `http://localhost:${config.port}`) + '/mcp'}`);
  console.log(`  데이터: ${config.dataDir}/hub.db`);
});

let closing = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (closing) return;
    closing = true;
    console.log('\n종료하는 중…');
    app.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
