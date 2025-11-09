import CDP from 'chrome-remote-interface';

const DEFAULT_PATTERNS = [/chatgpt\.com/i, /chat\.openai\.com/i];
const DEFAULT_BOOTSTRAP_URL = 'https://chatgpt.com/';
type TargetDescriptor = Awaited<ReturnType<typeof CDP.List>>[number];

export interface ChatGPTBootstrapOptions {
  host: string;
  port: number;
  bootstrapUrl?: string;
  includePatterns?: RegExp[];
  waitMs?: number;
  verbose?: boolean;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function ensureChatGPTTab(
  options: ChatGPTBootstrapOptions,
): Promise<boolean> {
  const {
    host,
    port,
    bootstrapUrl = DEFAULT_BOOTSTRAP_URL,
    includePatterns,
    waitMs = 1500,
    verbose,
  } = options;
  const patterns =
    includePatterns && includePatterns.length ? includePatterns : DEFAULT_PATTERNS;

  let targets: Awaited<ReturnType<typeof CDP.List>>;
  try {
    targets = await CDP.List({ host, port });
  } catch (error) {
    throw new Error(
      `Unable to list Chrome tabs via DevTools at ${host}:${port}: ${String(error)}`,
    );
  }

  const hasChatGPTTab = targets.some((target: TargetDescriptor) =>
    matchesChatGPT(target?.url ?? '', patterns),
  );
  if (hasChatGPTTab) {
    return false;
  }

  try {
    await CDP.New({
      host,
      port,
      url: bootstrapUrl,
    });
    if (verbose) {
      console.log(
        `Opened a ChatGPT tab via DevTools (${bootstrapUrl}). Log into ChatGPT in that window if prompted.`,
      );
    }
    if (waitMs > 0) {
      await delay(waitMs);
    }
    return true;
  } catch (error) {
    throw new Error(
      `Unable to open a ChatGPT tab via DevTools: ${String(error)}`,
    );
  }
}

const matchesChatGPT = (
  url: string,
  patterns: RegExp[] = DEFAULT_PATTERNS,
): boolean =>
  patterns.some((pattern) => {
    try {
      return pattern.test(url);
    } catch {
      return false;
    }
  });
