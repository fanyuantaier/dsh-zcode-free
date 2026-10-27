/**
 * OpenAI Chat Completions <-> Anthropic Messages translation.
 *
 * DSH reaches the bridge with OpenAI wire; the ZCode free endpoint speaks
 * Anthropic wire. These helpers are pure and unit-tested by
 * `node cli.mjs selftest`.
 */

const STOP_REASON_TO_FINISH = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  tool_use: 'tool_calls',
  max_tokens: 'length',
  pause_turn: 'stop',
};

export function mapStopReason(reason) {
  return STOP_REASON_TO_FINISH[reason] || 'stop';
}

function messageText(message) {
  if (message === null || message === undefined) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (typeof part === 'string' ? part : part && part.type === 'text' ? part.text : ''))
      .filter(Boolean)
      .join('');
  }
  return '';
}

function pushBlocks(messages, role, blocks) {
  if (blocks.length === 0) return;
  const last = messages[messages.length - 1];
  if (last && last.role === role) last.content.push(...blocks);
  else messages.push({ role, content: [...blocks] });
}

function textBlock(text) {
  return { type: 'text', text };
}

function imageBlockFromUrl(url) {
  const match = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,([A-Za-z0-9+/=]+)$/.exec(url || '');
  if (match) {
    return { type: 'image', source: { type: 'base64', media_type: 'image/' + match[1].toLowerCase().replace('jpeg', 'jpg'), data: match[2] } };
  }
  return undefined;
}

/** OpenAI request -> Anthropic Messages body. */
export function openaiToAnthropic(request, options = {}) {
  const systemParts = [];
  const messages = [];
  const tools = [];

  for (const tool of request.tools || []) {
    if (!tool || tool.type !== 'function' || !tool.function || !tool.function.name) continue;
    const schema = tool.function.parameters && typeof tool.function.parameters === 'object'
      ? tool.function.parameters
      : { type: 'object', properties: {} };
    tools.push({
      name: tool.function.name,
      description: tool.function.description || '',
      input_schema: schema.type ? schema : { type: 'object', properties: {}, ...schema },
    });
  }

  for (const message of request.messages || []) {
    const role = message.role;
    if (role === 'system' || role === 'developer') {
      const text = messageText(message);
      if (text) systemParts.push(text);
      continue;
    }
    if (role === 'tool') {
      const blocks = [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: messageText(message) }];
      if (message.status) blocks[0].status = message.status === 'failed' ? 'error' : 'success';
      pushBlocks(messages, 'user', blocks);
      continue;
    }
    if (role === 'assistant') {
      const blocks = [];
      const text = messageText(message);
      if (text) blocks.push(textBlock(text));
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          if (!call || !call.function) continue;
          let input = {};
          const raw = call.function.arguments;
          if (typeof raw === 'string' && raw.trim().length > 0) {
            try { input = JSON.parse(raw); } catch { input = { _raw: raw }; }
          } else if (raw && typeof raw === 'object') input = raw;
          blocks.push({ type: 'tool_use', id: call.id || '', name: call.function.name, input });
        }
      }
      pushBlocks(messages, 'assistant', blocks);
      continue;
    }
    if (role === 'user') {
      const blocks = [];
      const content = message.content;
      if (typeof content === 'string') {
        if (content.length > 0) blocks.push(textBlock(content));
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (!part) continue;
          if (part.type === 'text' && part.text) blocks.push(textBlock(part.text));
          else if (part.type === 'image_url') {
            const block = imageBlockFromUrl(part.image_url && part.image_url.url);
            if (block) blocks.push(block);
          }
        }
      }
      pushBlocks(messages, 'user', blocks);
    }
  }

  if (messages.length === 0) {
    pushBlocks(messages, 'user', [textBlock('(no user message)')]);
  } else if (messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: [textBlock('Continue.')] });
  }

  const maxTokens = Number(request.max_tokens ?? options.maxTokens ?? 32768) || 32768;
  const body = {
    model: request.model || options.defaultModel,
    max_tokens: maxTokens,
    messages,
  };
  if (systemParts.length > 0) body.system = systemParts.map((text) => textBlock(text));

  if (tools.length > 0) {
    body.tools = tools;
    const choice = request.tool_choice;
    if (choice === 'auto' || !choice) body.tool_choice = { type: 'auto' };
    else if (choice === 'required' || choice === 'any') body.tool_choice = { type: 'any' };
    else if (choice === 'none') { delete body.tools; }
    else if (choice && typeof choice === 'object' && choice.type === 'function' && choice.function && choice.function.name) {
      body.tool_choice = { type: 'tool', name: choice.function.name };
    }
  }

  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.top_p !== undefined) body.top_p = request.top_p;
  if (request.stop && typeof request.stop === 'string') body.stop_sequences = [request.stop];
  if (Array.isArray(request.stop) && request.stop.length > 0) body.stop_sequences = request.stop;
  if (request.stream) body.stream = true;

  const thinking = request.thinking || (request.reasoning_effort ? { effort: request.reasoning_effort } : undefined);
  if (thinking && typeof thinking === 'object') {
    if (thinking.type === 'enabled') {
      body.thinking = { type: 'enabled', budget_tokens: Number(thinking.budget_tokens || 4096) };
    } else if (thinking.effort && options.reasoningEfforts && options.reasoningEfforts.includes(thinking.effort)) {
      body.thinking = { type: 'enabled', budget_tokens: Number(options.reasoningBudget || 4096) };
    }
  }
  return body;
}

/** Anthropic JSON response -> OpenAI chat.completion. */
export function anthropicToOpenai(response, model, fallbackId) {
  const content = [];
  const toolCalls = [];
  const reasoning = [];
  for (const block of response.content || []) {
    if (!block) continue;
    if (block.type === 'text') content.push(block.text);
    else if (block.type === 'thinking') reasoning.push(block.thinking || '');
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id || '',
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
      });
    }
  }
  const usage = response.usage || {};
  const promptTokens = Number(usage.input_tokens || 0);
  const completionTokens = Number(usage.output_tokens || 0);
  return {
    id: response.id || fallbackId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response.model || model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: toolCalls.length > 0 && content.length === 0 ? null : content.join(''),
        ...(reasoning.length > 0 ? { reasoning_content: reasoning.join('') } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: mapStopReason(response.stop_reason),
    }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

function sseEvent(event, data) {
  return 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

/**
 * Anthropic SSE frames -> OpenAI chat.completion.chunk SSE text.
 * Pure generator: feed the parsed frames from sseEvents().
 */
export async function* anthropicSseToOpenai(frames, model) {
  let chatId = 'chatcmpl-' + Math.random().toString(36).slice(2, 14);
  let promptTokens = 0;
  let completionTokens = 0;
  let finishReason = null;
  const blockKind = new Map(); // anthropic content block index -> 'text' | tool name

  const chunk = (delta, extra = {}) => ({
    id: chatId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: extra.finish_reason === null ? null : extra.finish_reason }],
    ...(extra.usage ? { usage: extra.usage } : {}),
  });

  for await (const frame of frames) {
    const { event, data } = frame;
    if (event === 'message_start') {
      const message = data.message || {};
      if (message.id) chatId = message.id;
      promptTokens = Number((message.usage || {}).input_tokens || 0);
    } else if (event === 'content_block_start') {
      const block = data.content_block || {};
      blockKind.set(data.index, block.type === 'tool_use' ? 'tool:' + block.name : 'text');
      if (block.type === 'tool_use') {
        yield sseEvent('message', chunk({
          tool_calls: [{ index: (data.index | 0), id: block.id || '', type: 'function', function: { name: block.name, arguments: '' } }],
        }));
      }
    } else if (event === 'content_block_delta') {
      const delta = data.delta || {};
      if (delta.type === 'text_delta' && delta.text) yield sseEvent('message', chunk({ content: delta.text }));
      else if (delta.type === 'thinking_delta' && delta.thinking) yield sseEvent('message', chunk({ reasoning_content: delta.thinking }));
      else if (delta.type === 'input_json_delta' && delta.partial_json) {
        const index = Number(blockKind.get(data.index) || '').toString().startsWith('tool:')
          ? (data.index | 0)
          : (data.index | 0);
        yield sseEvent('message', chunk({
          tool_calls: [{ index, function: { arguments: delta.partial_json } }],
        }));
      }
    } else if (event === 'message_delta') {
      const delta = data.delta || {};
      finishReason = mapStopReason(delta.stop_reason);
      completionTokens = Number((data.usage || {}).output_tokens || completionTokens);
      yield sseEvent('message', chunk({}, { finish_reason: finishReason }));
    } else if (event === 'message_stop') {
      yield sseEvent('message', chunk({}, {
        finish_reason: finishReason || 'stop',
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      }));
      break;
    } else if (event === 'error') {
      const error = data.error || data;
      yield sseEvent('error', {
        error: {
          type: (error && error.type) || 'upstream_error',
          message: (error && error.message) || 'upstream stream error',
        },
      });
      break;
    }
  }
  yield 'data: [DONE]\n\n';
}
