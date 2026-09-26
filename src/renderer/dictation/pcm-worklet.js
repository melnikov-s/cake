/* global AudioWorkletProcessor, registerProcessor */
/* Microphone PCM stays in memory and is sent only to Cake's local inference service. */
class CakeDictationPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data === "flush") this.port.postMessage("flushed");
    };
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) this.port.postMessage(input.slice());
    return true;
  }
}
registerProcessor("cake-dictation-pcm", CakeDictationPcm);
