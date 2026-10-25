"""
从 example/ 里的公司样板提取样式部件，生成 src/export/templateParts.ts。

导出的 .docx / .xlsx 直接复用样板的 styles / theme / fontTable / settings，
保证字体、字号、段落间距、数字格式、边框与样板一致；文档正文和表格内容由 App 数据生成。
样板里的示例人物、行程和金额不会被复制。

用法：python -I scripts/extract-template-parts.py <样板.docx> <样板.xlsx>
"""
import json, re, sys, zipfile

docx_path, xlsx_path = sys.argv[1], sys.argv[2]
d = zipfile.ZipFile(docx_path)
x = zipfile.ZipFile(xlsx_path)

def text(z, name):
    return z.read(name).decode('utf-8')

settings = text(d, 'word/settings.xml')
# rsid / docId 是 Word 的编辑会话标识，不属于格式；去掉后 Word 会重新生成
settings = re.sub(r'<w:rsids>.*?</w:rsids>', '', settings, flags=re.S)
settings = re.sub(r'<w14:docId [^>]*/>|<w15:docId [^>]*/>', '', settings)

parts = {
    'DOCX_STYLES': text(d, 'word/styles.xml'),
    'DOCX_THEME': text(d, 'word/theme/theme1.xml'),
    'DOCX_FONT_TABLE': text(d, 'word/fontTable.xml'),
    'DOCX_SETTINGS': settings,
    'DOCX_WEB_SETTINGS': text(d, 'word/webSettings.xml'),
    'XLSX_STYLES': text(x, 'xl/styles.xml'),
    'XLSX_THEME': text(x, 'xl/theme/theme1.xml'),
}

out = ['// 自动生成：python -I scripts/extract-template-parts.py（来源：example/ 公司样板）',
       '// 不要手改；样板更新后重新运行脚本。', '']
for k, v in parts.items():
    out.append(f'export const {k} = {json.dumps(v, ensure_ascii=False)};')
    out.append('')
open('src/export/templateParts.ts', 'w', encoding='utf-8', newline='\n').write('\n'.join(out))
print({k: len(v) for k, v in parts.items()})
