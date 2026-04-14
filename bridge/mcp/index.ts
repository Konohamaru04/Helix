export interface McpCapabilitySurface {
  tools: boolean;
  resources: boolean;
  prompts: boolean;
}

export function getMcpCapabilitySurface(): McpCapabilitySurface {
  return {
    tools: false,
    resources: false,
    prompts: false
  };
}
