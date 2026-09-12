import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseImageRequest, imageConversationInstruction, selectImageReference } from '../src/image-conversation.ts'

test('accepts only a complete image action and keeps contextual prompt', () => {
  assert.deepEqual(parseImageRequest('{"image_request":{"prompt":"The orange cat we discussed, in a crown","use_reference":true}}'),
    { prompt: 'The orange cat we discussed, in a crown', useReference: true })
  assert.equal(parseImageRequest('Here is an example: {"image_request":{}}'), null)
  assert.equal(parseImageRequest('normal reply'), null)
})
test('rejects malformed and oversized action payloads', () => {
  assert.throws(() => parseImageRequest('{"image_request":{}}'), /Invalid/)
  assert.throws(() => parseImageRequest(JSON.stringify({image_request:{prompt:'x'.repeat(4001)}})), /Invalid/)
})
test('instruction requires context resolution and explicit user intent', () => {
  assert.match(imageConversationInstruction, /recent conversation/)
  assert.match(imageConversationInstruction, /only when the user requests/)
})
test('references stay scoped to eligible authors and reset cutoff', () => {
  const rows = [
    { id:'20', authorId:'other', createdTimestamp:100, attachments:[{name:'other.png',contentType:'image/png'}] },
    { id:'19', authorId:'bot', createdTimestamp:100, attachments:[{name:'art.png',contentType:'image/png'}] },
  ]
  assert.equal(selectImageReference(rows, 'user', 'bot', 'make it nighttime', null, 200)?.name, 'art.png')
  assert.equal(selectImageReference(rows, 'user', 'bot', 'make it nighttime', '19', 200), undefined)
  assert.equal(selectImageReference(rows, 'user', 'bot', 'hello', null, 200), undefined)
})


test('image actions can retrieve an earlier message instead of requiring reupload', () => {
  assert.deepEqual(parseImageRequest('{"image_request":{"prompt":"Repair the original","use_reference":true,"reference_message_id":"123"}}'),
    {prompt:'Repair the original',useReference:true,referenceMessageId:'123'})
  assert.throws(() => parseImageRequest('{"image_request":{"prompt":"Repair","reference_message_id":"https://example.com"}}'), /Invalid/)
})

test('production image path fetches the selected original instead of the newer bot edit', async () => {
  const { readFile } = await import('node:fs/promises')
  const { transpile } = await import('typescript')
  const source = await readFile(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const start = source.indexOf('      let referenceParts = imageParts')
  const end = source.indexOf('      const image = await generateImage', start)
  const factory = new Function('imageRequest', 'rawHistory', 'userId', 'selfId', 'imageParts', 'imagePaths', 'processAttachments', 'openaiRaw', 'Buffer',
    transpile(`return (async () => { ${source.slice(start, end)} return references; })();`))
  const history = [
    {id:'100',authorId:'user',attachments:[{name:'original.png',url:'https://example.com/original.png',mimeType:'image/png'}]},
    {id:'101',authorId:'bot',attachments:[{name:'revision.png',url:'https://example.com/revision.png',mimeType:'image/png'}]},
    {id:'102',authorId:'other',attachments:[{name:'unrelated.png',url:'https://example.com/unrelated.png',mimeType:'image/png'}]},
  ]
  const retrieved: string[] = []
  const paths: string[] = []
  const process = async (attachments: Array<{url:string}>) => {
    retrieved.push(...attachments.map(a => a.url))
    return {imageParts:[{type:'image_url',image_url:{url:'data:image/png;base64,b3JpZ2luYWw='}}],imagePaths:['/tmp/example-original.png']}
  }
  const result = await factory({useReference:true,referenceMessageId:'100'},history,'user','bot',[],paths,process,null,Buffer)
  assert.deepEqual(retrieved, ['https://example.com/original.png'])
  assert.equal(result[0].data.toString(), 'original')
  assert.deepEqual(paths, ['/tmp/example-original.png'])
  for (const referenceMessageId of ['102', '999']) {
    await assert.rejects(factory({useReference:true,referenceMessageId},history,'user','bot',[],[],process,null,Buffer), /unavailable/)
  }
})
