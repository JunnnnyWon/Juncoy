import { chromium } from '@playwright/test';

const browser = await chromium.launch({
  headless: false,
  slowMo: 500
});

const page = await browser.newPage({
  viewport: { width: 1920, height: 1080 }
});

await page.goto('http://localhost:3456');

console.log('\n✓ 브라우저가 열렸습니다.');
console.log('✓ 로그인하시고 화면을 확인해주세요.');
console.log('✓ 완료되면 터미널에서 Ctrl+C를 눌러주세요.\n');

// Keep the browser open
await page.waitForTimeout(3600000); // 1 hour timeout
