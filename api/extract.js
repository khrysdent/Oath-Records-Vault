// api/extract.js — Vercel serverless function (Node.js runtime)
// Node.js runtime handles large request bodies (base64-encoded PDFs).
// Edge runtime has a 4MB body limit which blocks real medical PDFs.

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '50mb',
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server.' });
  }

  try {
    const { messages, max_tokens, temperature } = req.body;

    // Stream the response from Anthropic back to the client.
    // Streaming keeps the connection alive and avoids timeout issues
    // on documents that take longer than a few seconds to process.
    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: max_tokens || 8192,
        temperature: temperature ?? 0,
        messages,
        stream: true,
      }),
    });

    if (!anthropicResponse.ok) {
      const error = await anthropicResponse.text();
      return res.status(anthropicResponse.status).json({ error });
    }

    // Collect the full streamed response and reconstruct the final message
    // in the same shape as a non-streaming response so the frontend works
    // without any changes.
    const reader = anthropicResponse.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let stopReason = null;
    let inputTokens = 0;
    let outputTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

      for (const line of lines) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);
          if (event.type === 'content_block_delta' && event.delta?.text) {
            fullText += event.delta.text;
          }
          if (event.type === 'message_delta' && event.delta?.stop_reason) {
            stopReason = event.delta.stop_reason;
          }
          if (event.type === 'message_start' && event.message?.usage) {
            inputTokens = event.message.usage.input_tokens;
          }
          if (event.type === 'message_delta' && event.usage) {
            outputTokens = event.usage.output_tokens;
          }
        } catch (e) {}
      }
    }

    return res.status(200).json({
      content: [{ type: 'text', text: fullText }],
      stop_reason: stopReason,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
