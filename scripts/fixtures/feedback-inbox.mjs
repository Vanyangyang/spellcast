const a = { source_id: 'fixture-inbox-a', thread_id: '11111111-1111-4111-8111-111111111111', cwd: 'G:/Examples/spellcast', label: '优化 Canvas 回复流程', protocol_agent: 'fixture', bound_at_ms: 1 };
const b = { source_id: 'fixture-inbox-b', thread_id: '22222222-2222-4222-8222-222222222222', cwd: 'G:/Examples/calendar', label: '整理周末行程', protocol_agent: 'fixture', bound_at_ms: 1 };
const reply = (id, binding, title, text) => ({ id, source_id: binding.source_id, source_label: binding.label, title, origin_node_id: null, revision: 1, created_at_ms: 1, updated_at_ms: 1, blocks: [{ id: 'body', type: 'text', title: '当前建议', text }] });
export const board = {
  topic: '隔离回复面板验收', form: 'spatial', form_reason: '', nodes: [], edges: [], messages: [],
  replies: [reply('reply-a', a, '让 Canvas 的反馈更清楚', '先让用户看清自己发送了什么，再突出当前结果。每次发送独立记录，原背景按需展开。'), reply('reply-b', b, '周末行程', '把周末留出半天空档。')],
  canvas: { revision: 1, compositions: [], proposals: [], objects: [a, b].map((binding, i) => ({ id: `obj-${i ? 'b' : 'a'}`, content: { type: 'reply', id: `reply-${i ? 'b' : 'a'}` }, source_id: binding.source_id, content_revision: 1, bindings: [], user_edited: false })),
    items: ['a', 'b'].map((id, i) => ({ item_id: `obj-${id}`, revision: 1, x: 40 + i * 460, y: 40, width: 400, height: 280, appearance: 'plain', removed: false, z: i })) }
};
const event = (seq, text, binding = a) => ({ seq, at_ms: Date.parse('2026-09-15T00:00:00+08:00') + seq * 60000, kind: 'say', text, ...(binding ? { source_id: binding.source_id, target_thread_id: binding.thread_id } : {}), anchors: binding ? [{ object_id: 'obj-a', content_revision: 1, block_id: 'body' }] : [] });
const desktop = binding => ({ thread_id: binding.thread_id, cwd: binding.cwd, accepted_at_ms: 1, host_status: 'submitted', previous_turn_id: null });
export const feedback = {
  pending: [], bindings: [a, b], deliveries: [
    { event: event(1, '旧请求：什么意思？'), phase: 'queued', client_message_id: 'one' },
    { event: event(2, '这只是测试，不需要修改。'), phase: 'handled', handled_at_ms: 2, client_message_id: 'two', desktop: desktop(a) },
    { event: event(3, '把建议整理成两个清楚的步骤。'), phase: 'responded', response_reply_id: 'reply-a', response_object_ids: ['obj-a'], responded_at_ms: 3, client_message_id: 'three', desktop: desktop(a) },
    { event: event(4, '第二步还需要一个例子，请先在画布里讨论。'), phase: 'submitted', client_message_id: 'four', desktop: desktop(a) },
    { event: event(5, '补充一个反例，说明什么时候不适合这样做。'), phase: 'failed', error: '连接暂时不可用', client_message_id: 'five' },
    { event: event(6, '其他工作区：周末的建议稍后再看。', b), phase: 'submitted', client_message_id: 'six', desktop: desktop(b) },
    { event: event(7, '来源未记录的旧留言', null), phase: 'waiting', client_message_id: 'seven' },
    { event: { ...event(8, '旧版选项操作'), kind: 'selection' }, phase: 'waiting', client_message_id: 'eight' },
  ]
};
feedback.pending = feedback.deliveries.filter(item => !['handled', 'responded'].includes(item.phase)).map(item => item.event);
export const scope = { workspace: 'workspace:g:/examples/spellcast', task: 'all' };
