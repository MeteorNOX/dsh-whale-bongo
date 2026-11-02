import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'runtime', 'electron-helper', 'native', 'WhaleNativeHelper.cs')
const output = path.join(root, 'runtime', 'electron-helper', 'whale-native-helper.exe')
const frameworks = process.env.WINDIR
  ? [
      path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
      path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
    ]
  : []
const csc = frameworks.find((candidate) => existsSync(candidate))
if (!csc) {
  console.error('找不到 .NET Framework 4.x csc.exe；请在 Windows 上运行此脚本。')
  process.exit(1)
}
const result = spawnSync(csc, [
  '/nologo',
  '/target:winexe',
  '/optimize+',
  '/codepage:65001',
  '/out:' + output,
  source,
], { stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status || 1)
console.log(output)
