import { CopilotClient } from "@github/copilot-sdk";

const client = new CopilotClient();
await client.start();

const session = await client.createSession({
    model: "gpt-5-mini",
    streaming: true,
});

// Send a prompt and wait for the full response, then print it.
const response = await session.sendAndWait({ prompt: "Hello, world!" });
console.log(response?.data?.content ?? "<no content>");

await client.stop();
