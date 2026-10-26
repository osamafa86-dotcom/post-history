import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { check } from '../i18n-check.mjs';
test('resources across JSON, XML, strings and catalog; literals and parse errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'i18n-'));
  const put = async (p, s) => { p = join(root, p); await mkdir(dirname(p), {recursive:true}); await writeFile(p,s); };
  try {
    await put('apps/web/messages/ar.json', '{"nested":{"yes":"نعم"},"extra":"زائد"}');
    await put('apps/web/messages/en.json', '{"nested":{"yes":"Yes"}}');
    await put('apps/android/res/values/strings.xml', '<resources><!-- <string name="ignored">س</string> --><string name="a">س</string></resources>');
    await put('apps/android/res/values-en/strings.xml', '<resources><string name="a">A</string></resources>');
    for (const lang of ['ar','en']) await put(`apps/ios/${lang}.lproj/Localizable.strings`, '/* comment */ "a" = "A";');
    await put('apps/ios/Info.xcstrings', JSON.stringify({sourceLanguage:'en',strings:{title:{localizations:{ar:{stringUnit:{state:'translated',value:'عنوان'}}}}}}));
    await put('apps/web/src/page.tsx', '// "تعليق"\nconst x = "نص";');
    let r = await check(root);
    assert.deepEqual(r.missing, [{group:'web:messages',key:'extra',missingLanguage:'en'}]);
    assert.deepEqual(r.literals, [{file:'apps/web/src/page.tsx',line:2}]);
    assert.equal(r.ok,false); assert.equal(r.errors.length,0);
    await put('apps/web/messages/en.json', '{"nested":{"yes":"Yes"},"extra":"Extra"}');
    await put('apps/web/src/page.tsx', '// "تعليق"');
    assert.equal((await check(root)).ok,true);
    for (const path of ['apps/web/src/ui.tsx','apps/android/src/Screen.kt','apps/ios/App/View.swift']) {
      await put(path, 'const separator = "،"; const digits = "٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹٫٬";');
    }
    await put('apps/ios/App/Tests/Example.swift', 'let title = "اختبار"');
    await put('apps/ios/App/ScreenTests.swift', 'let title = "اختبار"');
    assert.equal((await check(root)).ok, true);
    for (const path of ['apps/web/src/ui.tsx','apps/android/src/Screen.kt','apps/ios/App/View.swift']) await put(path, 'const title = "عنوان حقيقي";');
    const literals = (await check(root)).literals;
    assert.equal(literals.length, 3);
    assert.deepEqual(new Set(literals.map(x=>x.file.split('.').at(-1))), new Set(['tsx','kt','swift']));
    await put('apps/web/messages/en.json','{');
    assert.equal((await check(root)).errors[0].error,'resource_parse_failed');
  } finally { await rm(root,{recursive:true,force:true}); }
});
