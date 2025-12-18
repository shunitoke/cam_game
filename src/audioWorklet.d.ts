export {};

declare global {
  abstract class AudioWorkletProcessor {
    readonly port: MessagePort;
    constructor();
    abstract process(
      inputs: Float32Array[][],
      outputs: Float32Array[][],
      parameters: Record<string, Float32Array>
    ): boolean;
  }

  const sampleRate: number;

  function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void;
}
