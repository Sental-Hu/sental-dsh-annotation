# dsh-annotation

DSH Web 划选批注插件，当前版本 **0.1.16**，MIT 许可证。独立安装，不修改 DSH 核心源码。

在 AI 已完成回答的普通文本上划选，添加、修改、定位或删除批注。批注可作为独立引用卡片加入输入框，随消息发送；支持同一回答内的相邻普通段落，排除代码、表格、工具输出和跨消息选区。删除中间批注后，其余编号保持不变。

## 保存与直接发送

- **保存**：保存当前批注；新批注沿用原来的引用卡片行为，加入输入框供集中回复。
- **发送**：先保存当前批注，再通过 DSH 的公开会话接口直接发送原文和批注。只发送这一条，不插入、清空或发送输入框已有草稿及其他引用。
- 发送经会话持久化记录确认后，批注进入输入框上方的 **历史批注** 列表，并自动展开该列表。
- 保存失败时不发送。发送结果不明确时保留批注，显示 **核对发送**，只检查原有发送记录，不自动重发。
- 未提供公开 `conversation.send` 接口的 DSH 版本会禁用“发送”，原保存功能仍可用。

## 操作系统与移动端

同一插件包含运行在 DSH 服务端的 Node.js 部分和运行在浏览器的 Web 部分，没有 Windows 专属的业务依赖。Windows、macOS、Linux 上的兼容 DSH 可使用同一个插件包。

iPhone/iPad 的使用方式是通过 Safari 访问一台已运行 DSH 的电脑或服务器，不是在 iOS 中安装这个 npm 插件包。客户端代码可以共用，不需要维护 Windows/iOS 两套插件。原文高亮使用 CSS Custom Highlight API；[Safari 17.2 开始支持该 API](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/)，但这不代表整个插件已通过 iOS 验收。触摸选区、系统选词菜单、软键盘和窄屏弹窗仍需真机测试。当前未完成 iOS 真机验证。

## 兼容策略

| 边界       | 实现                                                                             |
| ---------- | -------------------------------------------------------------------------------- |
| 插件加载   | 仅声明直接使用的公开会话 UI、输入引用模块；不依赖已删除的 client-runtime 包      |
| 会话持久化 | 按公开方法能力选择旧版 inspect/readFrom 或新版 open(id, "read")/read/close       |
| 消息格式   | 适配 V3 用户消息结构，保留旧批次标记识别，不修改原会话日志                       |
| 聊天视图   | 支持旧 session.chat 和新版 useChat 公开订阅；DOM 定位仍依赖 data-chat-anchor-key |
| 输入卡片   | 使用公开输入接口，按引用长度换算编辑器位置，保留版本冲突检查                     |
| 故障处理   | 未知持久化接口返回明确错误；批注渲染错误限制在插件区域，不冒充发送成功           |

当前在 DSH **0.1.5-rc.1** 上做实际运行验证。旧版 **0.1.0-rc.8** 的持久化协议由回归测试覆盖；本次没有另启动旧版本执行完整界面测试。版本范围表示可安装范围，不保证所有未来预发布版本均已验证。

后续 DSH 若保持这些公开契约，不需要随版本号修改批注业务层；发生破坏性接口变化时，优先调整 `src/compat/` 下的适配器并补充契约测试。模块加载器或 DOM 锚点被删除仍可能需要适配，不能保证永久免维护。

## 刷新后的输入引用

DSH 当前会将输入框草稿保存为纯文字，刷新后引用卡片可能显示为 `[批注 3]`。插件会提示未关联标签。打开对应批注卡片，核对正文后点击 **恢复引用**，即可原位重新关联；重复标签需要先清理。插件不根据编号自动猜测批注身份，也不会自动发送消息。

## 数据与回退

批注继续保存在原 `dsh_annotation` sidecar domain，schema version 1 不变；确认发送的 Markdown 投影位于会话工作区 `.dsh/annotations/`。升级不迁移或覆盖已有批注。保留旧安装包与 DSH profile 配置即可回退插件；不要删除用户存储目录。

## 安装

需要 Git、符合 package.json 要求的 Node.js 和 pnpm 11.19.0，并已安装兼容版本的 DSH。私有仓库需要先登录有访问权限的 GitHub 账号。

```sh
git clone https://github.com/hushengtao24-jpg/dsh-annotation.git
cd dsh-annotation
pnpm install --frozen-lockfile
pnpm build
pnpm pack
dsh plugin --profile web add ./dsh-annotation-0.1.16.tgz
```

上述命令将包安装到 web profile；若使用其他 profile，请替换 web。安装后重启对应 DSH 服务并刷新窗口，在一条 AI 已完成的普通文本回答中划选，检查“批注”菜单及“保存 / 发送”按钮。

卸载命令：`dsh plugin --profile web remove dsh-annotation`。卸载保留已有批注数据。

本仓库提供源码安装方式，尚未发布到 npm；请先构建并安装生成的 tgz 文件。

## 开发验证

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

源码入口 `src/index.ts`、`src/client/index.tsx`；兼容边界 `src/compat/`；业务与数据层 `src/service.ts`、`src/repository.ts`。新增适配器应保留身份检查、只读访问、句柄释放及真实持久化确认，不以读取失败、内存快照或超时推断发送成功。
