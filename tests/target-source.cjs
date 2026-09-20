const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileTargetSource, watchTargetSource } = require('../dist/target-source');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'target-source-'));
const write = (name, body) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
};

test('a file source reads the config it was pointed at', () => {
  const file = write('main.json', { chain: 'robinhood', targets: [{ slug: 'a', quantity: 1 }] });
  const source = fileTargetSource(file);
  assert.equal(source.name, file);
  assert.deepEqual(source.watchPaths(), [file]);
  assert.equal(source.read().targets.length, 1);
});

test('a watch source merges the watched files and tolerates the ones not created yet', () => {
  const main = write('main2.json', { chain: 'robinhood', targets: [{ slug: 'a', quantity: 1 }] });
  const later = path.join(dir, 'later.json');
  const appeared = [];
  const source = watchTargetSource(main, [later, write('extra.json', { targets: [{ slug: 'b', quantity: 1 }] })], {
    onAppear: (file) => appeared.push(file),
  });
  assert.deepEqual(source.watchPaths(), [main, later, path.join(dir, 'extra.json')]);
  const first = source.read();
  assert.equal(first.targets.length, 2, 'the missing file contributes nothing');

  fs.writeFileSync(later, JSON.stringify({ targets: [{ slug: 'c', quantity: 2 }] }));
  const second = source.read();
  assert.equal(second.targets.length, 3, 'the file is picked up once it exists');
  assert.deepEqual(appeared, [later]);
});

test('an unreadable main config is an error, an unreadable watched file keeps the queue', () => {
  const source = watchTargetSource(path.join(dir, 'nope.json'), [path.join(dir, 'missing.json')], {
    onMissing: () => {},
    tolerateMissingMain: true,
  });
  assert.deepEqual(source.read().targets, []);

  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, 'not json');
  const strict = fileTargetSource(broken);
  assert.throws(() => strict.read(), /not valid JSON/);
});
