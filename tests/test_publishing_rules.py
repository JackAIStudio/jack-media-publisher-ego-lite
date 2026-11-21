"""保护发布文档间的核心声明、分区、封面槽、小红书横竖屏偏好、链接完整性及快速通道脚本硬边界规则。"""
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TABLE = (ROOT / 'references/platforms.md').read_text(encoding='utf-8')


class PublishingRules(unittest.TestCase):
    def test_declarations(self):
        section = TABLE.split('\n## 内容声明\n', 1)[1].split('\n## ', 1)[0]
        branches = {
            '小红书': ('笔记含AI合成内容', '不选'),
            '抖音': ('内容由AI生成', '无需添加自主声明'),
            'B站': ('含AI生成内容', '内容无需标注'),
            '微信视频号': ('含AI生成内容', '无需标注'),
        }
        for platform, labels in branches.items():
            with self.subTest(platform=platform):
                row, = (line for line in section.splitlines() if line.startswith('| ' + platform + ' |'))
                for label in labels:
                    self.assertIn(label, row)
        for path in [ROOT / 'SKILL.md', ROOT / 'README.md', *sorted((ROOT / 'references').glob('*.md'))]:
            with self.subTest(file=path.name):
                text = path.read_text(encoding='utf-8')
                self.assertNotRegex(text, r'一律「无需标注」|原创声明\s+默认不开|不要从视频内容自行推断是否勾选原创')

    def test_bilibili_category_snapshot(self):
        text = (ROOT / 'references/bilibili-categories.md').read_text(encoding='utf-8')
        categories = {}
        for line in text.splitlines():
            cells = [cell.strip() for cell in line.split('|')[1:-1]]
            if not cells or not cells[0].isdigit():
                continue
            for i in range(0, len(cells), 2):
                order, name = int(cells[i]), cells[i + 1]
                self.assertNotIn(order, categories)
                categories[order] = name
        self.assertEqual(sorted(categories), list(range(1, 31)))
        self.assertEqual(len(set(categories.values())), 30)
        self.assertEqual([categories[n] for n in (1, 11, 12, 28, 30)], ['影视', '人工智能', '科技数码', 'vlog', '生活经验'])

    def test_wechat_cover_slots(self):
        section = TABLE.split('\n### 视频号封面\n', 1)[1].split('\n---', 1)[0]
        portrait, = (line for line in section.splitlines() if line.startswith('| 竖屏'))
        landscape, = (line for line in section.splitlines() if line.startswith('| 横屏'))
        self.assertRegex(portrait, r'1 个.*3:4.*共用')
        self.assertRegex(landscape, r'2 个.*个人主页卡片 3:4.*分享卡片 4:3')
        for path in [ROOT / 'SKILL.md', *sorted((ROOT / 'references').glob('*.md'))]:
            with self.subTest(file=path.name):
                text = path.read_text(encoding='utf-8')
                self.assertNotRegex(text, r'视频号[^\n]*(?:只剩单一|只剩这一个|两个都要变)|横屏封面在视频号[^\n]*没有槽可放')

    def test_xiaohongshu_orientation_cover_rule(self):
        for rel in ('SKILL.md', 'README.md', 'references/platforms.md', 'references/verification.md'):
            text = (ROOT / rel).read_text(encoding='utf-8')
            with self.subTest(file=rel):
                self.assertRegex(text, r'竖屏[^\n]*3:4')
                self.assertRegex(text, r'横屏[^\n]*4:3')
                self.assertNotRegex(text, r'给了封面时默认用\s*3:4|封面默认用\s*3:4\s*竖图')

    def test_no_activity_association_rule(self):
        for rel in ('SKILL.md', 'references/platforms.md', 'references/verification.md', 'references/gotchas.md'):
            text = (ROOT / rel).read_text(encoding='utf-8')
            with self.subTest(file=rel):
                self.assertRegex(text, r'关联活动|禁止关联活动')
                self.assertIn('取消关联', text)
                self.assertNotRegex(text, r'改走「参与话题\s*→\s*搜索更多话题」|走「参与话题\s*→\s*搜索更多话题」精确选词')

        forbidden_link_activity_click = re.compile(
            r'''(?:click|press)\s*\([^)]*(?:text="关联"|has-text\("关联"\)|text="关联活动"|text="添加活动"|text="参与活动"|text="参与话题")'''
        )
        for script in sorted((ROOT / 'scripts').rglob('*.mjs')):
            source = script.read_text(encoding='utf-8')
            with self.subTest(script=str(script.relative_to(ROOT))):
                self.assertIsNone(
                    forbidden_link_activity_click.search(source),
                    f'Hard boundary violation: script must never click to link activities ({script.name})',
                )

    def test_markdown_links_and_anchors(self):
        for path in [ROOT / 'SKILL.md', ROOT / 'README.md', *sorted((ROOT / 'references').glob('*.md'))]:
            text = path.read_text(encoding='utf-8')
            for match in re.finditer(r'\[[^\]]+\]\((?:<([^>]+)>|([^)\s]+))\)', text):
                target = match.group(1) or match.group(2)
                if target.startswith(('http://', 'https://')):
                    continue
                path_part, _, anchor = target.partition('#')
                resolved = (path.parent / path_part).resolve() if path_part else path
                with self.subTest(source=path.name, target=target):
                    self.assertTrue(resolved.exists(), f'Missing link target: {resolved}')
                    if anchor:
                        target_text = resolved.read_text(encoding='utf-8')
                        headings = [
                            re.sub(r'[^\w\u4e00-\u9fff\- ]+', '', h).strip().lower().replace(' ', '-')
                            for h in re.findall(r'^#+\s+(.+)$', target_text, re.M)
                        ]
                        self.assertIn(anchor.lower(), headings, f'Missing anchor #{anchor} in {resolved.name}')

    def test_fast_path_scripts_syntax_and_hard_boundaries(self):
        scripts = sorted((ROOT / 'scripts').rglob('*.mjs'))
        self.assertGreaterEqual(len(scripts), 6, 'Expected modular fast-path scripts under scripts/')
        forbidden_publish_click = re.compile(
            r'''(?:click|press)\s*\([^)]*(?:发布笔记|立即投稿|text="发布"|text="发表"|has-text\("发布"\)|has-text\("发表"\)|text="帖子"|has-text\("帖子"\)|预排期帖子|定时发布|安排时间)'''
        )
        for script in scripts:
            with self.subTest(script=str(script.relative_to(ROOT))):
                check = subprocess.run(
                    ['node', '--check', str(script)],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(check.returncode, 0, f'Syntax error in {script}: {check.stderr}')
                source = script.read_text(encoding='utf-8')
                self.assertIsNone(
                    forbidden_publish_click.search(source),
                    f'Hard boundary violation: script must never click final publish or schedule buttons ({script.name})',
                )

    def test_validate_module_and_dry_run(self):
        validate_url = (ROOT / 'scripts/lib/validate.mjs').as_uri()
        probe_js = f"""
import {{ calcXhsTitleWeight, calcDouyinTitleLength, validateAndNormalizeJob }} from {json.dumps(validate_url)};
const out = {{
  agentW: calcXhsTitleWeight("Agent"),
  sampleW: calcXhsTitleWeight("给Agent装个Skill，后台控制浏览器"),
  realW: calcXhsTitleWeight("A处你完蛋了，Gpt和Gemini要把你打趴下来"),
  dySample: calcDouyinTitleLength("给Agent装个Skill，后台控制浏览器"),
  dyEmoji: calcDouyinTitleLength("🔥"),
}};
console.log(JSON.stringify(out));
"""
        proc = subprocess.run(['node', '--input-type=module', '-e', probe_js], capture_output=True, text=True, check=True)
        res = json.loads(proc.stdout)
        self.assertEqual(res['agentW'], 3)
        self.assertEqual(res['sampleW'], 16)
        self.assertEqual(res['realW'], 19)
        self.assertEqual(res['dySample'], 21)
        self.assertEqual(res['dyEmoji'], 2)

        # Test dry-run with bundled fixtures (clip.mp4 + cover-3x4.png)
        with tempfile.TemporaryDirectory() as tmpdir:
            job_path = Path(tmpdir) / 'job.json'
            job_path.write_text(
                json.dumps(
                    {
                        'title': 'Ego 快速通道预检',
                        'video': str(ROOT / 'fixtures/clip.mp4'),
                        'covers': {'3x4': str(ROOT / 'fixtures/cover-3x4.png')},
                        'topics': ['剪辑教程', '效率工具'],
                        'original': True,
                        'aiGenerated': False,
                        'bilibili': {'category': '科技数码'},
                    },
                    ensure_ascii=False,
                ),
                encoding='utf-8',
            )
            dry = subprocess.run(
                ['node', str(ROOT / 'scripts/run.mjs'), '--job', str(job_path), '--dry-run'],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(dry.returncode, 0, f'Dry-run failed: {dry.stderr}\n{dry.stdout}')
            payload = json.loads(dry.stdout)
            self.assertTrue(payload['dryRun'])
            self.assertEqual(payload['normalized']['platforms'], ['xhs', 'douyin', 'bilibili', 'wechat', 'x'])
            self.assertEqual(payload['normalized']['xhs']['coverRatio'], '3x4')
            self.assertEqual(payload['normalized']['wechat']['location'], '不显示位置')
            self.assertEqual(payload['normalized']['x']['description'], '')
            self.assertEqual(payload['normalized']['x']['tweetText'], '')
            self.assertEqual(payload['normalized']['x']['coverRatio'], '3x4')
            self.assertTrue(payload['normalized']['x']['coverPath'].endswith('cover-3x4.png'))
            self.assertFalse(payload['normalized']['allowActivities'])

            # Test platform-specific douyin.title override when original title exceeds 30 chars (but XHS <= 20)
            dy_job_path = Path(tmpdir) / 'job_dy_override.json'
            dy_job_path.write_text(
                json.dumps(
                    {
                        'title': 'Gemini 4 Neon 和 Gpt-6.2 Astra谁更能打？',
                        'video': str(ROOT / 'fixtures/clip.mp4'),
                        'covers': {'3x4': str(ROOT / 'fixtures/cover-3x4.png')},
                        'topics': ['Gemini', 'GPT'],
                        'original': True,
                        'aiGenerated': False,
                        'douyin': {'title': 'Gemini Neon和Gpt-6.2 Astra谁更能打？'},
                        'xhs': {'videoPath': str(ROOT / 'fixtures/clip.mp4')},
                        'bilibili': {'category': '人工智能'},
                    },
                    ensure_ascii=False,
                ),
                encoding='utf-8',
            )
            dry2 = subprocess.run(
                ['node', str(ROOT / 'scripts/run.mjs'), '--job', str(dy_job_path), '--dry-run'],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(dry2.returncode, 0, f'Douyin title override dry-run failed: {dry2.stderr}\n{dry2.stdout}')
            p2 = json.loads(dry2.stdout)['normalized']
            self.assertEqual(p2['xhs']['title'], 'Gemini 4 Neon 和 Gpt-6.2 Astra谁更能打？')
            self.assertEqual(p2['douyin']['title'], 'Gemini Neon和Gpt-6.2 Astra谁更能打？')
            self.assertEqual(p2['titleMetrics']['xhsWeight'], 20)
            self.assertEqual(p2['titleMetrics']['dyLen'], 34)
            self.assertTrue(p2['xhs']['videoPath'].endswith('clip.mp4'))

    def test_five_platforms_equal_and_xhs_original_first(self):
        for rel in ('SKILL.md', 'README.md', 'references/platforms.md'):
            text = (ROOT / rel).read_text(encoding='utf-8')
            with self.subTest(file=rel):
                self.assertNotIn('可选扩展渠道', text)
                self.assertIn('X（Media Studio）', text)
                self.assertNotIn('默认四平台', text)
        gotchas = (ROOT / 'references/gotchas.md').read_text(encoding='utf-8')
        skill = (ROOT / 'SKILL.md').read_text(encoding='utf-8')
        self.assertIn('原片优先', gotchas)
        self.assertIn('原片优先', skill)

    def test_x_orientation_cover_rule(self):
        for rel in ('SKILL.md', 'README.md', 'references/platforms.md', 'references/verification.md', 'references/gotchas.md'):
            text = (ROOT / rel).read_text(encoding='utf-8')
            with self.subTest(file=rel):
                self.assertRegex(text, r'竖屏[^\n]*(?:9:16|3:4)')
                self.assertRegex(text, r'横屏[^\n]*16:9')
                self.assertNotIn('自定义 16:9 缩略图', text)


if __name__ == '__main__':
    unittest.main()
