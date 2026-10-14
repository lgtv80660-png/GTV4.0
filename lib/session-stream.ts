import { readSession } from './session-store';
// Backpressure and cancellation are preserved; revocation is checked while data is consumed.
export function sessionStream(body: ReadableStream<Uint8Array>, token: string) { let checked = 0; const reader = body.getReader(); return new ReadableStream<Uint8Array>({ async pull(controller) { try {
        if (Date.now() - checked >= 15000) {
            await readSession(token);
            checked = Date.now();
        }
        const next = await reader.read();
        if (next.done)
            controller.close();
        else
            controller.enqueue(next.value);
    }
    catch {
        await reader.cancel().catch(() => { });
        controller.error(new Error('Media unavailable'));
    } }, cancel() { return reader.cancel(); } }); }
