# Ego Lite 页面控件与选择器

用 `ego-browser skill` 取得本机 API 用法。每次切换编辑页、封面卡或弹窗后，重新观察当前页。控件优先使用当前 `page.snapshot()` 返回的实时 `ref`，以下实测 CSS 选择器与 DOM 特征用于精确过滤目标、复核边界条件，以及通过 `page.evaluate()` 回读状态。以下定位依据来自 2026-09 至 2026-11-18 网页实测。

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

- **小红书**：读内容类型声明行 `.d-select` 显示文本（留空时显示占位符「添加内容类型声明」）；原创声明的原生 `<input type="checkbox">` 为 `0×0`，**应点击可见开关 `.custom-switch-card .d-switch`**，并在《原创声明须知》弹窗中勾选 `.originalContainer .d-checkbox-simulator` 后点「声明原创」。
- **抖音**：点击自主声明并确认弹窗后，回读表单上 `.selectBox-buZRzi` 的文本；原创若「无此项」据实记录。
- **B站**：打开「创作声明」在六个 `.bcc-option` 中核对选中标记，收起后回读该行 `input.bcc-select-input-inner` 显示值；下方「是否添加内容授权声明（非必选）」内 `.auth-content`（「内容为自制：未经作者允许，禁止转载」）就在同一 `.bcc-select-option-list` 下拉内，实测可与「含AI生成内容」同时勾存（选中后含 `.option-text-selected`）。
- **微信视频号**：收起候选菜单后读取「视频标注」按钮文本（「含AI生成内容」或占位符「选择视频标注」），并核对「声明原创」（`.declare-original-checkbox` + `.declare-original-dialog` 确认弹窗）与「位置」（表单 `.post-position-wrap .location-name` 设为「不显示位置」）。详情见 [草稿复查与交接](<verification.md#草稿复查与交接>)。

---

## 话题与分区

### 小红书
1. 点击 `button.contentBtn.topic-btn`（原生话题按钮）→ 编辑器插入 `#`；
2. 用键盘输入查询词（不要先清空正文）；
3. 等候本轮建议面板出现并稳定（先出现的可能是旧建议），精确核对名称后**重新快照取当前项 `ref` 点击**；
4. 在正文内回读 `a.tiptap-topic`（或 `data-topic` 中的 `name`）。

### 抖音
每轮从最新快照取 `button "#添加话题"` 的 `ref` 点击，输入查询词。候选可能附带浏览量数字，精确核对词条名后从新快照点击选定；随后在简介内回读 `[data-mention="#"]` 文本，移出已选实体再打下一个词。

### B站
- **标签**：先清理平台自动填充的无关标签（点击该标签 `.label-item-v2-container` 内的 `svg.close`，**空框切勿按 Backspace**）；随后在标签框逐个输入目标标签按 Enter，回读 `.label-item-v2-content`。遇到「仅话题」词回车静默消失时，走「参与话题 → 搜索更多话题」精确选词确认，仍不成则记作待办，不悄悄改词。
- **投稿分区**：打开「分区」下拉，只在当前可见的 `.drop-list-v2-container.human-type-list` 中读取 `.drop-list-v2-content-wrp` 里的 `.drop-list-v2-item .item-cont-main` 选项，选中后收起并回读分区显示值。同名词也可能在 `.tag-pre-wrp` 标签区出现，需各自核对。

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
1. 若打开编辑器时先出现「智能生成封面」弹窗，先点「不使用」；
2. 点击目标面板并验证 `isPanelActive('#editor_4_3')` 或 `isPanelActive('#editor_16_9')` 为 `true` 后，再向该激活面板选图；
3. 点完成按钮 `div.button.submit`；若提示是否将 4:3 同步到 16:9，**必须选「不同步，手动编辑」**；
4. 返回主表单 `.cover-content`（主卡缩略图用 `.cover-img` 的 CSS `background-image` 渲染，非 `<img>`）读回 `coverList` 绑定：`extra` 对应 4:3 首页图、`main` 对应 16:9 空间图（保存复开同一 `draftId` 后，图片资源常由 `edited` 转入 `origin`）。

### 抖音：横竖两个 tab
点击「竖封面3:4」或「横封面4:3」卡片打开编辑器，注意「设置竖封面」/「设置横封面」tab 切换后可能弹窗「使用此素材作为封面？」→ 点「直接编辑」。上传区为 `"点击上传文件或拖拽文件到这里"`。完成并从「继续编辑」复开本稿后，从两张主卡片内的 `img.currentSrc` 回读图片资源并对照原图构图。

### 微信视频号：按成片方向核对卡片
先等视频上传和转码完成，在主页面「封面预览」按名称和比例找到可见卡片（竖屏 1 个「个人主页和分享卡片(3:4)」；横屏 2 个「个人主页卡片 3:4」和「分享卡片 4:3」），点击对应卡片的「编辑」（如 `.vertical-img-wrap .edit-btn` / `.horizon-img-wrap .edit-btn`）。横屏设完第一张卡片后打开第二张时可能浮出「使用此素材作为封面？」提示，**点击「直接编辑」**真正进入编辑弹窗，在弹窗上传对应来图、核对构图后点击「确认」，再回到主卡片核对回显图片。
