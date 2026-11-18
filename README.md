# Jack Media Publisher for Ego Lite

让支持 Agent Skills 的桌面助手用 Ego Lite 把一条本地视频准备成小红书、抖音、B 站和微信视频号的草稿。每个平台填好就存稿，再从平台入口复开同一稿，核对标题、话题、声明和封面。最后由作者手动发布。

## 安装

1. 安装并完成 Ego Lite 的首次设置。在终端运行 `ego-browser skill`，确认能看到当前版本的操作指南。处理真实草稿时，先在 Ego Lite 登录准备使用的创作账号。[Ego Lite](https://lite.ego.app/)
2. 新安装时，在支持 `~/.agents/skills/` 的宿主上将本仓库克隆到以下目录。私有仓库需要具有读取权限的 GitHub 账号。Beta 版沿用手动入口 `/jack-media-publisher-ego-lab`。

   ```sh
   mkdir -p "$HOME/.agents/skills"
   git clone https://github.com/JackAIStudio/jack-media-publisher-ego-lite.git \
     "$HOME/.agents/skills/jack-media-publisher-ego-lab"
   ```

3. 在助手的斜杠菜单里选择 `/jack-media-publisher-ego-lab`。平台字段、标题规则、B 站分区、踩坑记录和验收说明都随仓库安装。

已有本仓库的克隆可用以下命令更新。

```sh
git -C "$HOME/.agents/skills/jack-media-publisher-ego-lab" pull --ff-only
```

## 第一次使用

输入下面的命令。助手会把自带的 2 秒样片和 3:4 封面放进本地表单，填写标题与话题并保存。刷新后再次打开草稿，应能读回同一标题、话题、2 秒片长和 240 × 320 的封面尺寸。

```text
/jack-media-publisher-ego-lab 离线演练
```

准备真实草稿时，附上本地成片，写明目标平台和原标题。已有封面可以一起提供，有指定话题或明确说明是否含 AI 生成素材也一并给出。例如：

```text
/jack-media-publisher-ego-lab 把附上的成片准备成小红书、抖音、B 站和视频号草稿，原标题用「一纸成灯」。使用附上的三张封面，话题根据片子选，成片含 AI 生成画面，保存后复开给我检查。
```

助手按成片实际分辨率（含旋转信息）与封面像素自动映射：
- **小红书**：竖屏视频（高 > 宽）默认用 3:4 竖封面，横屏视频（宽 > 高）默认用 4:3 横封面（若用户指定其他比例或仅提供某一张则按实际处理）。
- **抖音**：同时使用 4:3 横封面和 3:4 竖封面。
- **B 站**：使用 4:3 首页推荐封面和 16:9 个人空间封面。
- **微信视频号**：竖屏成片使用共用 3:4 卡片；横屏成片使用 3:4 个人主页卡片和 4:3 分享卡片。

素材探测可用 FFmpeg 中的 `ffprobe`。若未说明目标平台、AI 生成素材事实或存在同名历史空间，助手会先给出紧凑对齐清单确认后再动手。

## 草稿在哪里

| 平台 | 复查入口 |
|---|---|
| 小红书 | 点「暂存离开」，从同一浏览器、同一账号的草稿箱找到视频笔记，点「编辑」。 |
| 抖音 | 点「暂存离开」，从上传页点「继续编辑」，用标题和视频时长确认稿件。 |
| B 站 | 点「存草稿」，从「稿件管理 → 草稿」复开目标条目。 |
| 微信视频号 | 点「保存草稿」，在另一个标签页从草稿箱复核。原编辑页最后设置视频标注，留给作者发表。 |

## 本机规则自检

改动平台规则或参考文档后，可在仓库根目录运行规则回归测试：

```sh
python3 -IB -m unittest discover -s tests -p 'test_*.py' -v
```

[完整操作规则](<SKILL.md>) · [平台暗坑记录](<references/gotchas.md>) · [验收依据](<references/verification.md>)

本项目沿用了 Jack 的四平台发布偏好，草稿辨认与中断续做参考了 Oil 的发布流程。[Jack Media Publisher](https://github.com/JackAIStudio/jack-media-publisher) · [Oil Video Publisher](https://github.com/oil-oil/video-publisher-skill)
