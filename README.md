# OnlyArabics · 只有阿语

一个只做「背阿拉伯语单词」这一件事的网站：没有广告、没有课程推销、没有会员、没有排行榜和打卡焦虑。

线上地址：<https://onlyaras.cn>

## 功能

- 按级别背词：入门 / 中级 / 高级，对标 CEFR；另有教学大纲 2/4/6/8 级和专四词汇
- 单词卡片：标准发音、词根与同根词、近反义词、动词全人称变位、简单例句
- 两段式自测：先回忆再看答案，连续答对 4 次算掌握，之后按 SM-2 遗忘曲线安排复习
- 邮箱注册登录，多设备同步学习进度

## 技术栈

- [Cloudflare Workers](https://developers.cloudflare.com/workers/) + [Hono](https://hono.dev/)：后端 API（`src/`）
- [Cloudflare D1](https://developers.cloudflare.com/d1/)：SQLite 数据库（表结构见 `d1/schema.sql`）
- 原生 JavaScript + Tailwind CSS：前端（`public/`）
- [Resend](https://resend.com/)：发送验证码邮件

## 本地运行

需要 Node.js 18 以上。

```bash
npm install
cp .dev.vars.example .dev.vars     # 填一个随机的 JWT_SECRET
npm run db:init                    # 建表
npm run db:seed                    # 导入示例词库
npm run dev                        # 打开 http://localhost:8787
```

本地没有配置 `RESEND_API_KEY` 时，注册验证码会打印在终端里。

## 部署到自己的 Cloudflare 账号

1. `npx wrangler d1 create onlyarabics-db`，把输出的 `database_id` 填进 `wrangler.toml`
2. `npx wrangler d1 execute onlyarabics-db --remote --file=d1/schema.sql`
3. `npx wrangler secret put JWT_SECRET`，需要发信的话再配置 `RESEND_API_KEY`
4. 修改 `wrangler.toml` 里的 `ENVIRONMENT`、`EMAIL_FROM`、`ADMIN_EMAILS`
5. `npm run deploy`

## 关于词库

本仓库只包含 25 个示例词条（`d1/sample_seed.sql`），用于开发和演示。线上网站的完整词库（12,525 个词条）和发音音频部分整理自教材与考试资料，涉及第三方版权，因此不随代码公开。

## 反馈

发现 bug 或有功能建议，欢迎提 Issue。

## 许可证

[GNU AGPL-3.0](LICENSE)。修改本项目并以网站形式提供服务时，需要同样公开修改后的源代码。
