# 一次性修复：删掉两段坏 replace 续行，补上完整 sanitize 定义
import io

p = r'I:\教务系统\app\scripts\fetch-music.mjs'
BS = chr(92)   # 反斜杠
DQ = chr(34)   # 双引号

good = [
    "const sanitize = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, " + DQ + "'" + DQ + ").replace(/&quot;/g, " + DQ + '"' + DQ + ")",
    "  .replace(/[<>:" + DQ + "/" + BS + BS + "|?*]/g, '').replace(/[!]/g, '').replace(/[" + BS + "u0000-" + BS + "u001f]/g, '').replace(/" + BS + "s+/g, ' ').trim().slice(0, 80);",
]

lines = io.open(p, encoding='utf-8').read().split('\n')
out, i = [], 0
while i < len(lines):
    ln = lines[i]
    stripped = ln.strip()
    if stripped.startswith('.replace(/[<>:'):
        out.extend(good)
        i += 1
        while i < len(lines) and lines[i].strip().startswith('.replace(/[<>:'):
            i += 1
        continue
    out.append(ln)
    i += 1

io.open(p, 'w', encoding='utf-8').write('\n'.join(out))
print('sanitize fixed')
