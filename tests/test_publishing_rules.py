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
            self.assertEqual(payload['normalized']['xhs']['location'], '')
            self.assertEqual(payload['normalized']['douyin']['location'], '')
            self.assertEqual(payload['normalized']['wechat']['location'], '不显示位置')
            self.assertTrue(any('location' in w for w in payload['normalized']['warnings']))
            self.assertFalse(payload['normalized']['bilibili']['authDeclaration'])
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

    def test_black_bar_orientation_mismatch_gate(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            pillarbox = tmp / 'pillarbox_16x9.mp4'
            letterbox = tmp / 'letterbox_9x16.mp4'

            # 1) 16:9 横屏容器里塞 9:16 竖屏内容 + 左右纯黑边（模拟达芬奇竖屏误放横屏时间线）
            subprocess.run(
                [
                    'ffmpeg', '-y', '-v', 'error',
                    '-f', 'lavfi', '-i', 'testsrc2=size=202x360:rate=15:duration=2',
                    '-vf', 'pad=640:360:(ow-iw)/2:0:black',
                    '-pix_fmt', 'yuv420p', str(pillarbox),
                ],
                check=True,
            )
            # 2) 9:16 竖屏容器里塞 16:9 横屏内容 + 上下纯黑边（反向错导）
            subprocess.run(
                [
                    'ffmpeg', '-y', '-v', 'error',
                    '-f', 'lavfi', '-i', 'testsrc2=size=360x202:rate=15:duration=2',
                    '-vf', 'pad=360:640:0:(oh-ih)/2:black',
                    '-pix_fmt', 'yuv420p', str(letterbox),
                ],
                check=True,
            )

            base_job = {
                'title': '黑边熔断测试',
                'covers': {'3x4': str(ROOT / 'fixtures/cover-3x4.png')},
                'topics': ['AI'],
                'original': True,
                'aiGenerated': False,
                'bilibili': {'category': '人工智能'},
            }

            # 验证 pillarbox 默认被硬阻断
            job1 = tmp / 'job1.json'
            job1.write_text(json.dumps({**base_job, 'video': str(pillarbox)}, ensure_ascii=False), encoding='utf-8')
            r1 = subprocess.run(['node', str(ROOT / 'scripts/run.mjs'), '--job', str(job1), '--dry-run'], capture_output=True, text=True)
            self.assertNotEqual(r1.returncode, 0, f'Expected pillarbox video to be blocked: {r1.stdout}')
            err1 = json.loads(r1.stderr)
            self.assertEqual(err1['activeViewport']['mismatchType'], 'pillarbox_portrait_in_landscape')

            # 验证显式 allowBlackBars=true 可放行并记入 warnings
            job1_allow = tmp / 'job1_allow.json'
            job1_allow.write_text(
                json.dumps({**base_job, 'video': str(pillarbox), 'allowBlackBars': True}, ensure_ascii=False),
                encoding='utf-8',
            )
            r1_ok = subprocess.run(['node', str(ROOT / 'scripts/run.mjs'), '--job', str(job1_allow), '--dry-run'], capture_output=True, text=True)
            self.assertEqual(r1_ok.returncode, 0, f'Expected allowBlackBars=true to pass: {r1_ok.stderr}')
            p1_ok = json.loads(r1_ok.stdout)['normalized']
            self.assertTrue(any('allowBlackBars=true' in w for w in p1_ok['warnings']))

            # 验证反向 letterbox 同样被硬阻断
            job2 = tmp / 'job2.json'
            job2.write_text(json.dumps({**base_job, 'video': str(letterbox)}, ensure_ascii=False), encoding='utf-8')
            r2 = subprocess.run(['node', str(ROOT / 'scripts/run.mjs'), '--job', str(job2), '--dry-run'], capture_output=True, text=True)
            self.assertNotEqual(r2.returncode, 0, f'Expected letterbox video to be blocked: {r2.stdout}')
            err2 = json.loads(r2.stderr)
            self.assertEqual(err2['activeViewport']['mismatchType'], 'letterbox_landscape_in_portrait')

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

    def test_location_not_hardcoded_and_optional_three_platforms(self):
        for rel in ('SKILL.md', 'references/platforms.md', 'references/selectors.md', 'references/gotchas.md'):
            text = (ROOT / rel).read_text(encoding='utf-8')
            with self.subTest(file=rel):
                self.assertNotIn('默认设为「温州世贸大厦」', text)
                self.assertNotIn('默认目标「温州世贸大厦」', text)
        skill = (ROOT / 'SKILL.md').read_text(encoding='utf-8')
        self.assertIn('绝不写死', skill)
        self.assertIn('每次必问', skill)

        with tempfile.TemporaryDirectory() as tmpdir:
            job_path = Path(tmpdir) / 'job_loc.json'
            job_path.write_text(
                json.dumps(
                    {
                        'title': '三平台地点透传测试',
                        'video': str(ROOT / 'fixtures/clip.mp4'),
                        'covers': {'3x4': str(ROOT / 'fixtures/cover-3x4.png')},
                        'topics': ['AI'],
                        'original': True,
                        'aiGenerated': False,
                        'location': '示例地标A',
                        'douyin': {'location': '示例地标B'},
                        'xhs': {'location': ''},
                        'bilibili': {'category': '人工智能'},
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
            self.assertEqual(dry.returncode, 0, f'Location dry-run failed: {dry.stderr}\n{dry.stdout}')
            norm = json.loads(dry.stdout)['normalized']
            self.assertEqual(norm['wechat']['location'], '示例地标A')
            self.assertEqual(norm['douyin']['location'], '示例地标B')
            self.assertEqual(norm['xhs']['location'], '')

    def test_companion_copy_profile_hook_and_privacy(self):
        gitignore = (ROOT / '.gitignore').read_text(encoding='utf-8')
        self.assertIn('/local/', gitignore)

        example_path = ROOT / 'references/copy-profile.example.md'
        self.assertTrue(example_path.exists(), 'Missing references/copy-profile.example.md')
        example_text = example_path.read_text(encoding='utf-8')
        for channel in ('微信朋友圈', 'X', 'YouTube'):
            self.assertIn(channel, example_text)
        for private_token in ('12月线下', '温州', '练两组', '@I_am_oil_oil', 'followjack.cn'):
            self.assertNotIn(private_token, example_text)

        for rel in ('SKILL.md', 'README.md'):
            text = (ROOT / rel).read_text(encoding='utf-8')
            with self.subTest(file=rel):
                self.assertIn('local/copy-profile.md', text)
                self.assertIn('copy-profile.example.md', text)
                self.assertIn('微信朋友圈', text)
                self.assertIn('YouTube', text)

    def test_image_mode_validation_and_rules(self):
        # 1. 文档必须明确记录原生图文关键入口、上限与暗坑
        skill = (ROOT / 'SKILL.md').read_text(encoding='utf-8')
        gotchas = (ROOT / 'references/gotchas.md').read_text(encoding='utf-8')
        selectors = (ROOT / 'references/selectors.md').read_text(encoding='utf-8')
        self.assertIn('mode: "image"', skill)
        self.assertIn('finderNewLifeCreate', skill)
        self.assertIn('waitForFileChooser', gotchas)
        self.assertIn('feature-guide__btn', selectors)

        # 2. 校验 scripts/run.mjs 对图文模式（自动推导与显式 mode="image"）的 dry-run
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp = Path(tmpdir)
            sample_img = str(ROOT / 'fixtures/cover-3x4.png')

            # 2a) 自动推导 image 模式 + 默认国内三平台 + 19 字通用标题 + 未配 BGM 预警
            job_ok = tmp / 'img_ok.json'
            job_ok.write_text(
                json.dumps(
                    {
                        'title': '12.19 示例实战小班｜1页看懂',
                        'images': [sample_img],
                        'description': '第一行说明\n第二行说明',
                        'topics': ['AI工具', '人工智能'],
                        'original': True,
                        'aiGenerated': False,
                    },
                    ensure_ascii=False,
                ),
                encoding='utf-8',
            )
            r_ok = subprocess.run(
                ['node', str(ROOT / 'scripts/run.mjs'), '--job', str(job_ok), '--dry-run'],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(r_ok.returncode, 0, f'Image dry-run failed: {r_ok.stderr}\n{r_ok.stdout}')
            norm = json.loads(r_ok.stdout)['normalized']
            self.assertEqual(norm['mode'], 'image')
            self.assertEqual(norm['platforms'], ['xhs', 'douyin', 'wechat'])
            self.assertEqual(len(norm['images']), 1)
            self.assertEqual(norm['images'][0]['width'], 240)
            self.assertEqual(norm['images'][0]['height'], 320)
            self.assertEqual(norm['wechat']['location'], '不显示位置')
            self.assertEqual(norm['wechat']['title'], '12.19 示例实战小班｜1页看懂')
            self.assertTrue(any('BGM' in w for w in norm['warnings']))

            # 2b) 抖音图文 20 字硬拦截（21 字应报错）
            job_dy21 = tmp / 'img_dy21.json'
            job_dy21.write_text(
                json.dumps(
                    {
                        'mode': 'image',
                        'title': '一二三四五六七八九十一二三四五六七八九十一',  # 21 字
                        'images': [sample_img],
                        'topics': ['AI'],
                        'aiGenerated': False,
                        'music': '钢琴',
                    },
                    ensure_ascii=False,
                ),
                encoding='utf-8',
            )
            r_dy21 = subprocess.run(
                ['node', str(ROOT / 'scripts/run.mjs'), '--job', str(job_dy21), '--dry-run'],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(r_dy21.returncode, 0, 'Expected 21-char Douyin image title to be blocked')
            self.assertIn('21/20', r_dy21.stderr)

            # 2c) 抖音图文显式提供 <=20 字覆写标题 + music 配置归一化通过
            job_override = tmp / 'img_override.json'
            job_override.write_text(
                json.dumps(
                    {
                        'mode': 'image',
                        'title': '12.19 示例 AI 实战小班｜1页看懂',  # 21 字符，XHS 加权 <=20，视频号 <=22
                        'images': [sample_img],
                        'topics': ['AI'],
                        'aiGenerated': False,
                        'douyin': {'title': '12.19 示例AI实战小班｜1页看懂', 'music': '轻柔钢琴纯音乐'},
                        'wechat': {'music': 'none'},
                    },
                    ensure_ascii=False,
                ),
                encoding='utf-8',
            )
            r_ov = subprocess.run(
                ['node', str(ROOT / 'scripts/run.mjs'), '--job', str(job_override), '--dry-run'],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(r_ov.returncode, 0, f'Image override dry-run failed: {r_ov.stderr}\n{r_ov.stdout}')
            norm_ov = json.loads(r_ov.stdout)['normalized']
            self.assertEqual(norm_ov['douyin']['music']['action'], 'search')
            self.assertEqual(norm_ov['douyin']['music']['query'], '轻柔钢琴纯音乐')
            self.assertEqual(norm_ov['wechat']['music']['action'], 'none')
            self.assertFalse(any('BGM' in w for w in norm_ov['warnings']))

            # 2d) 拒绝不支持的 .gif 图片格式
            fake_gif = tmp / 'anim.gif'
            fake_gif.write_bytes(b'GIF89a')
            job_gif = tmp / 'img_gif.json'
            job_gif.write_text(
                json.dumps(
                    {
                        'mode': 'image',
                        'title': 'GIF 拦截测试',
                        'images': [str(fake_gif)],
                        'aiGenerated': False,
                    },
                    ensure_ascii=False,
                ),
                encoding='utf-8',
            )
            r_gif = subprocess.run(
                ['node', str(ROOT / 'scripts/run.mjs'), '--job', str(job_gif), '--dry-run'],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(r_gif.returncode, 0, 'Expected .gif to be blocked in image mode')
            self.assertIn('.gif', r_gif.stderr)


if __name__ == '__main__':
    unittest.main()
