# Ego Lite 页面控件与选择器

用 `ego-browser skill` 取得本机 API 用法。每次切换编辑页、封面卡或弹窗后，重新观察当前页。控件优先使用当前 `page.snapshot()` 返回的实时 `ref`，以下实测 CSS 选择器与 DOM 特征用于精确过滤目标、复核边界条件，以及通过 `page.evaluate()` 回读状态。以下定位依据来自 2026-09 至 2026-11-19 网页实测。

---

## 文件上传

四个平台的 `<input type="file">` 常处于隐藏状态（`0×0`、`opacity: 0` 或 `display: none`）。用 Ego Lite 操作时：
- 页面中已存在对应且唯一的文件框时，可用 `page.setInputFiles(selector, [absPath])` 直接投递。
- 点击投放区后才动态创建文件选择器，或同页存在多个隐藏框时，先创建 `const chooserPromise = page.waitForFileChooser({ timeout: 10_000 })`，再用 `page.click(ref)` 点击可见投放区，随后 `await (await chooserPromise).setFiles(absPath)`。

| 平台 | 可见上传区与目标控件 | 定位时核对 |
|---|---|---|
| 小红书 | 视频上传卡内的 `div.drag-over`（内含 `input.upload-input`） | 接收 `.mp4` / `.mov`，上传后在「填写标题」框核对回填 |
| 抖音 | 快照中「点击上传 或直接将视频文件拖入此区域」按钮 `ref` | 2026-11-18 实测已找不到 `div.drag-over` |
| B站 | `.bcc-upload-wrapper div.upload-area`（或内部接收 `.mp4` 的视频框） | 同页另有 `1×1` 旧 input 和接收 `.txt` 的字幕 input，不可仅凭 `name=buploader` 盲选 |
| 微信视频号 | `wujie-app` shadow root 表单中可见视频上传卡入口 `ref` | 先确认平台上传与转码完成，再填写字段；封面从对应卡片「编辑」进入 |

### 微信视频号的 wujie 组件

发布表单位于当前页面 `wujie-app` 的 shadow root（Ego Lite 的 CSS 选择器自动穿透 open shadow root，但在 `page.evaluate()` 中需显式穿过 `document.querySelector('wujie-app')?.shadowRoot` 查询）。

- 正常从可见界面选图后，如编辑区或主卡仍显示视频首帧，可在对应卡片或弹窗的 `input[type=file]` 上做只读核对，确认文件类型与控件所属子窗口匹配：

```js
const file = input.files?.[0];
const componentWindow = input.ownerDocument.defaultView;
const sameRealmFile = !!file && file instanceof componentWindow.File;
```

---

## 填写字段与回读

| 平台 | 字段 | 实测选择器 |
|---|---|---|
| 小红书 | 标题 | `input.d-text[placeholder*="填写标题"]` |
| 小红书 | 正文 | `div.tiptap.ProseMirror`（contenteditable） |
| 抖音 | 标题 | `input.semi-input[placeholder*="作品标题"]` |
| 抖音 | 简介 | `div.zone-container.editor-kit-container` |
| B站 | 标题 | `input.input-val[placeholder*="稿件标题"]` |
| B站 | 简介 | `div.ql-editor`（Quill，默认不填；**不接受 `fill`**） |
| B站 | 标签 | `input.input-val[placeholder*="回车键Enter"]` |
| 微信视频号 | 短标题 | 表单中「短标题」标签对应的文本框 |
| 微信视频号 | 视频描述 | 表单里的 `div.input-editor` |

### Quill 编辑器（B站简介）兼容写法

B 站简介 `div.ql-editor` 如需清空或填写，不可直接用 `fill`，需用 `page.evaluate()` 聚焦后调用 `execCommand`：

```js
const ed = document.querySelector('div.ql-editor');
ed.focus();
const sel = window.getSelection();
const r = document.createRange();
r.selectNodeContents(ed);
r.collapse(false);
sel.removeAllRanges();
sel.addRange(r);
document.execCommand('insertText', false, '要填的内容'); // 清空用 'delete'
```

### 内容声明与原创授权控件

- **小红书**：读内容类型声明行 `.d-select` 显示文本（留空时显示占位符「添加内容类型声明」）；原创声明的原生 `<input type="checkbox">` 为 `0×0`，**必须精准点击 `.original-wrapper .d-switch`**（不要宽泛点 `.custom-switch-card .d-switch`，该选择器同时命中「定时发布」），并在《原创声明须知》弹窗中勾选 `.originalContainer .d-checkbox-simulator` 后点「声明原创」。底部「暂存离开」位于 `<xhs-publish-btn>` 内，直接用 `page.click('text="暂存离开"')` 可自动穿透 shadow DOM。
- **抖音**：点击自主声明并确认弹窗后，回读表单上 `.selectBox-buZRzi` 的文本；原创若「无此项」据实记录。
- **B站**：打开「创作声明」在六个 `.bcc-option` 中直接 DOM 精准点击目标项（「含AI生成内容」或「内容无需标注」，不选「个人观点，仅供参考」等其他项），收起后回读该行 `input.bcc-select-input-inner` 与 `.bcc-option.selected`；下方「是否添加内容授权声明（非必选）」内 `.auth-content`（「内容为自制：未经作者允许，禁止转载」）**默认不勾选**（仅在显式指定 `authDeclaration: true` 时才勾）。
- **微信视频号**：收起候选菜单后读取「视频标注」按钮文本（「含AI生成内容」「无需标注」或占位符「选择视频标注」），并核对「声明原创」（`.declare-original-checkbox` + 仅过滤 `height > 80` 的可见 `.declare-original-dialog, .weui-desktop-dialog` 确认弹窗）与「位置」（绝不写死默认地标；点击 `.post-position-wrap .position-display` 打开 `.location-filter-wrap`；若作者本次指定了具体地标，在 `input[placeholder*="搜索附近位置"]` 输入地标并点 `.weui-desktop-search__btn`，按 `.option-item .name` **严格精确匹配**点击，切勿模糊命中同前缀商铺/停车场，随后回读 `.post-position-wrap .location-name`；未指定地点时则直接点击首项「不显示位置」）。草稿箱列表直达路径为 `https://channels.weixin.qq.com/platform/post/draftListManager`（需 `waitForFunction` 等 `wujie-app` 渲染）。详情见 [草稿复查与交接](<verification.md#草稿复查与交接>)。
- **抖音与小红书可选地点（2026-11-24 实测）**：仅在作者每次明确确认添加地点时填写——抖音在「扩展信息 → 添加标签 → 位置」点击 `text="输入地理位置"` 键入关键词搜选主地标（注意如搜简称可能返回全称 POI，优先选主地标并避开接送点/停车场/写字楼招商处/分店）；小红书在「添加组件 → 添加地点」点击 `text="添加地点"` 键入关键词搜选主地标（避开 A 栋/南门/北门/东门等附属点），存草稿复开后回读确认已落地。

---

## 话题与分区

### 小红书
1. **先滚动并聚焦正文 `div.tiptap.ProseMirror` 上部区域**（避开底部悬浮 `<xhs-publish-btn>` 拦截点击，且防止关键词误敲进标题框），再点击 `button.contentBtn.topic-btn`（原生话题按钮）→ 编辑器插入 `#`；
2. 用键盘输入查询词（不要先清空正文）；
3. 等候本轮 `.tippy-box .item` 建议面板出现并稳定（先出现的可能是旧建议），优先选不带「活动 / 参与 / 有奖」标注的普通话题，精确核对名称后点击；
4. 在正文内回读 `a.tiptap-topic`（或 `data-topic` 中的 `name`）；
5. **检查并解除自动关联的活动**：选完话题后检查正文下方「关联活动」区块（紧邻「商业组件」上方）。只要 Jack 未明确提起要求参与某活动，凡出现红色「取消关联」按钮一律点击解除，并复核该区块已无「取消关联」。

### 抖音
每轮点击 `text="#添加话题"`（或从最新快照取 `ref`），输入查询词。候选浮层可能附带播放量数字或「活动 / 任务 / 激励」标注，排除编辑器自身并避开带活动/任务标注的候选，按精确名优先点击；随后在简介内回读 `[data-mention="#"]` / `[data-mention]` 文本，移出已选实体再打下一个词。绝不点击下方「添加活动 / 任务」等挂载入口（除非 Jack 明确提起）。

### B站
- **标签**：先清理平台自动填充的无关标签（先 `scrollIntoView`，再用鼠标点击该标签 `.label-item-v2-container` 内关闭按钮的坐标，**不要直接对 `<svg>` 调 `.click()`，空框切勿按 Backspace**）；随后在标签框逐个输入目标标签按 Enter，回读 `.label-item-v2-content`。遇到「仅话题」词回车静默消失时，**严禁未经 Jack 明确同意擅自走「参与话题」挂载活动**，直接将原词记作待办汇报，不悄悄改词也不擅自挂活动。
- **投稿分区**：先 `scrollIntoView` 再打开 `.select-controller` 下拉，只在当前可见的 `.drop-list-v2-container.human-type-list` 中读取 `.drop-list-v2-content-wrp` 里的 `.drop-list-v2-item .item-cont-main` 选项，选中后收起并回读分区显示值。同名词也可能在 `.tag-pre-wrp` 标签区出现，需各自核对。

### 微信视频号
在 `div.input-editor` 描述编辑器里直接写入 `#话题`（按需补空格分段），从同一编辑器内的 `span.hl.topic` 回读平台已识别的高亮话题名称。

---

## 封面

### 小红书：hover-only 入口、4:3 比例切换与旧版退路
悬停主封面卡（`.default--ai-cover-layout` 或触发 `.cover-edit-entry`），打开 `.main-cover-editor-modal`。在弹窗上传控件 `input[aria-label="上传封面图片"]`（或 `input.upload-input[accept*="image"]`）选对应来图后，**若为横屏视频（4:3 封面），务必切到左侧「裁剪」并点击「4:3」比例按钮**（弹窗默认选中 3:4），确认画面未被裁切后点击「完成」。
- 封面比例按当前视频显示方向选择（竖屏 3:4 / 横屏 4:3，或按用户指定）；
- 若视频较大导致新版封面编辑器提示视频加载问题，点击**「回退到旧版封面编辑弹窗」**再上传并选择相应比例裁切确认。

### B站：两个独立面板

```text
.cover-editor-panel-canvas-title
  ├─ #editor_4_3    首页推荐封面（4:3）
  └─ #editor_16_9   个人空间封面（16:9）
```

**⚠️ `active` 类在 `#editor_4_3` / `#editor_16_9` 的父元素（`parentElement`）上，不在元素自身；且严禁用 `/active/.test(className)`（会误匹配 `inactive`）**，必须按空白切分 token 判定：

```js
const isPanelActive = id =>
  (document.querySelector(id)?.parentElement?.className || '')
    .split(/\s+/)
    .includes('active');
```

操作流程：
1. 滚到 `.cover-content`，若页面尚未抽帧出默认图，入口为空槽 `.cover-empty-pill` / `.cover-slot`；已抽帧时为「更改封面」；点击打开编辑器后若先出现「智能生成封面」弹窗，先点「不使用」；
2. 点击目标面板并验证 `isPanelActive('#editor_4_3')` 或 `isPanelActive('#editor_16_9')` 为 `true` 后，再向该激活面板选图；
3. 点完成按钮 `div.button.submit`；若提示是否将 4:3 同步到 16:9，**必须选「不同步，手动编辑」**；
4. 返回主表单 `.cover-content`（主卡缩略图用 `.cover-img` 的 CSS `background-image` 渲染，非 `<img>`）读回 `coverList` 绑定：`extra` 对应 4:3 首页图、`main` 对应 16:9 空间图（保存复开同一 `draftId` 后，图片资源常由 `edited` 转入 `origin`）。

### 抖音：横竖两个 tab
先 `scrollIntoView` 等待滚动到位，再点击 `.cover-Jg3T4p >> nth=0` 打开双封面编辑器；切换「设置竖封面」/「设置横封面」tab 后如弹出「使用此素材作为封面？」点「直接编辑」。弹窗内优先对 `.upload-tips-KomyJM`（或「上传封面」/「点击上传文件或拖拽文件到这里」）挂 `waitForFileChooser` 并用 `mouse.click` 点击避开弹窗指针拦截。点底部「完成」并从「继续编辑」复开本稿后，从两张主卡片内的 `img.currentSrc` 回读图片资源并对照原图构图。

### 微信视频号：按成片方向核对卡片
先等视频上传和转码完成，在主页面「封面预览」按名称和比例找到可见卡片（竖屏 1 个「个人主页和分享卡片(3:4)」；横屏 2 个「个人主页卡片 3:4」和「分享卡片 4:3」），点击对应卡片的「编辑」（如 `.vertical-img-wrap .edit-btn` / `.horizon-img-wrap .edit-btn`）。横屏设完第一张卡片后打开第二张时可能浮出「使用此素材作为封面？」提示，**点击「直接编辑」**真正进入编辑弹窗，在弹窗内优先对**当前可见**的 `.single-cover-uploader-wrap` 挂 `waitForFileChooser` 并点击触发选图（避免横屏双卡共存两个隐藏 `input[type="file"]` 导致误传到另一个槽位），核对构图后**严格点击可见 `.weui-desktop-dialog__ft` 内文本等于 `"确认"` 的橙色主按钮**（切勿模糊匹配隐藏的「确定」），再回到主卡片核对回显图片尺寸（`810×1080` 与 `1440×1080`）。

### X（Media Studio）：自定义缩略图两步路径
无论是媒体详情页（`/library/<mediaKey>/edit`）还是撰写弹窗内点击「编辑媒体设置」展开的面板，先按成片实际方向（竖屏选 9:16 或 3:4 竖图，横屏选 16:9 横图）挑好封面，上传**必须严格按两步执行**：
1. 点击蓝色描边按钮 **`button:has-text("更改缩略图")`**，播放器下方会出现「选择一帧或`上传`图片」以及「取消」「选择」按钮；
2. **先挂 `page.waitForFileChooser()`，再点击文字链接 `a:text-is("上传")`**（**切勿**盲找页面里的第一个 `input[type="file"]`，该控件是媒体库主上传框，会把封面误传成独立图片素材！）；
3. 选图建议先压成 **≤ 1 MB 的同方向高清 JPG**（实测超过 2 MB 的无损 PNG 易慢传或被拒）；上传后静候转圈完成与 `upload.json (FINALIZE 201)` → `edit.json (200)` +「保存成功」提示；
4. **验收方式**：视频播放器若已解码第 0 帧或 `currentTime > 0`，肉眼画面仍会停在视频帧，必须调用 `page.fetch("/1/library/get.json?...&media_key=<mediaKey>")` 核对服务器端返回的新缩略图已切换为 `https://pbs.twimg.com/media/...`（取代默认 `amplify_video_thumb/...`）并可拉图核验构图。

---

## 原生图文模式实测控件

原生图文模式（`mode: "image"`）在小部分核心控件上与视频页不同（2026-11-28 实测）：

### 小红书图文（`?target=image`）
- **传图控件**：`input.upload-input`（`accept=".jpg,.jpeg,.png,.webp"`、`multiple`），支持一次 `setInputFiles` 传入多张本地图片。
- **新手指引气泡**：进入图文编辑页后可能弹出 `.feature-guide__btn`（「我知道了」），必须先点击关闭再聚焦正文 `div.tiptap.ProseMirror`，否则会吞掉正文输入。
- **暂存离开**：底部 `<xhs-publish-btn>` 属 closed shadow DOM，`text="暂存离开"` 在图文页可能匹配 0 节点，**优先执行 `page.snapshot({ scope: "full_page" })` 匹配 `text "暂存离开"` 对应 `@ref` 点击**。
- **草稿箱复开**：点「草稿箱」后确认位于「图文笔记」Tab，按标题与最新 `保存于` 时间戳点击「编辑」。

### 抖音图文（`default-tab=3`）
- **传图控件**：同页可能同时存在视频与图片两个 `input[type="file"]`，须筛选 `accept.includes("image")` 的节点注入。
- **正文换行**：向 `div.zone-container.editor-kit-container` 写入多段正文时，必须**逐行 `keyboard.insertText(line)` + `keyboard.press("Enter")`**，不要把含 `\n` 的整段文本一次 `insertText` 写入。
- **选择音乐**：左侧标题「选择音乐」不可点，右侧真正触发器为 `.action-Q1y01k`（已选音乐后变为文本「修改音乐」）。抽屉内优先定位 `input[placeholder="搜索音乐"]` 键入纯音乐关键词按 Enter，hover 候选曲目行后点击行内「使用」按钮，再静音暂停。
- **已选音乐回读**：主表单通过 `.sub-desc-title-yp0uUv` 读取当前选中曲目名称。

### 微信视频号图文（`finderNewLifeCreate`，`wujie-app` shadow DOM）
- **传图控件**：`wujie-app` shadowRoot 内的 `.ant-upload-drag-container` **不能**直接对内部隐藏 `input[type="file"]` 调 `setInputFiles`（实测静默失效），必须先挂 `page.waitForFileChooser()` 再用 `page.mouse.click` 点击 `.ant-upload-drag-container` 选图；上传完成后在 `img.slider-img` 核对原图真实像素。
- **独立图文标题**：`input[placeholder*="填写标题"]`（上限 22 字符）。
- **背景音乐更换**：点击 `.bgm-form-content-wrap` 外层的 `.link-display-wrap` 展开 `.link-list-options`；不加音乐时点击「不添加音乐」，搜歌时在 `input[placeholder*="搜索歌名"]` 逐字 `keyboard.type()` 并点击 `.weui-desktop-search__btn` + Enter。命中结果后**不能只点 `.song-info`（仅试听）**，必须找到包含「选择」按钮的整行容器，hover 后点击该行右侧「选择」按钮，并确认 `.bgm-form-content-wrap` 文本更新且 `.link-list-options` 已收起（防止遮挡下方「视频标注」和「保存草稿」）。

### X 原生发帖与 B 站动态（按需）
- **X（`x.com/compose/post`）**：图片通过 `input[data-testid="fileInput"] >> nth=0` 注入（≤ 4 张）；推文框 `[data-testid="tweetTextarea_0"]` 默认留空，绝不点击 `[data-testid="tweetButton"]` 或 `[data-testid="scheduleOption"]`。
- **B 站动态（`t.bilibili.com`）**：先带 `{ credentials: "include" }` 调 `nav` 验登录态；挂 `waitForFileChooser()` 点击 `.bili-dyn-publishing__tools__item.pic` 传图；选填标题填 `input.bili-dyn-publishing__title__input`（≤ 20 字），正文填 `.bili-dyn-publishing .bili-rich-textarea__inner`，无草稿箱直接留页交接。
