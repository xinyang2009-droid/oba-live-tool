// Windows 打包脚本（针对本机环境做了适配）
//
// 解决了三个坑：
// 1. electron-builder 26 依赖树收集不兼容 pnpm 11
//    本项目用 nodeLinker: hoisted（扁平 node_modules），但 electron-builder 判断
//    「pnpm 项目是否为 hoisted」时执行 `pnpm config list`，而 pnpm 11 改成了 JSON 输出
//    + camelCase 键名（nodeLinker），electron-builder 按 key=value + kebab-case
//    （node-linker）解析，永远匹配不上，导致它去 .pnpm 目录找包并崩溃。
//    做法：打包期间临时隐藏 pnpm-lock.yaml，让它按 npm 项目处理（扁平布局正好适配），
//    结束后自动恢复。
// 2. electron 本体与打包资源默认从 GitHub 下载，国内基本下不动。
//    做法：默认注入 npmmirror 镜像地址。
// 3. 上一次打包残留的 app.asar 会被安全软件（如 360）长时间锁住，
//    electron-builder 清空输出目录时报 EBUSY 直接失败。
//    做法：打包前先尝试清理；清不掉就自动改用带时间戳的输出目录，绕开被锁文件。
//
// 注意：winCodeSign 压缩包内含 macOS 符号链接文件，Windows 普通账户无创建符号链接权限，
// 需要「以管理员身份运行」或开启「开发者模式」，否则解压会失败。

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lockFile = join(root, 'pnpm-lock.yaml')
const lockBackup = `${lockFile}.buildbak`
const hadLock = existsSync(lockFile)

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// 决定输出目录：优先标准目录 release/<version>，
// 若上一轮产物被占用无法删除，则改用带时间戳的备用目录
function resolveOutput() {
  const standard = `release/${version}`
  const standardPath = join(root, standard)
  if (!existsSync(standardPath)) return standard

  try {
    rmSync(standardPath, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    // 删除失败，继续往下判断
  }

  if (!existsSync(standardPath)) return standard

  const fallback = `release/${version}-${Date.now()}`
  console.warn(
    `[build] 提示：${standard} 中有文件被占用（多为安全软件锁定 app.asar），无法清理。`,
  )
  console.warn(`[build] 本次改用备用输出目录：${fallback}`)
  return fallback
}

const outputDir = resolveOutput()

const env = {
  ...process.env,
  ELECTRON_MIRROR:
    process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??
    'https://npmmirror.com/mirrors/electron-builder-binaries/',
}

try {
  if (hadLock) {
    renameSync(lockFile, lockBackup)
    console.log('[build] 已临时隐藏 pnpm-lock.yaml（兼容 electron-builder）')
  }
  execSync(
    `electron-builder --publish never -c.directories.output=${outputDir}`,
    {
      cwd: root,
      stdio: 'inherit',
      env,
      shell: true,
    },
  )
  console.log(`[build] 打包完成，产物目录：${outputDir}`)
} catch (error) {
  console.error('[build] 打包失败')
  process.exitCode = 1
} finally {
  if (hadLock && existsSync(lockBackup) && !existsSync(lockFile)) {
    renameSync(lockBackup, lockFile)
    console.log('[build] 已恢复 pnpm-lock.yaml')
  }
}
