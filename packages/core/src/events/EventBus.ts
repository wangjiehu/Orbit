import { EventEmitter } from 'events';

export class EventBus extends EventEmitter {
  constructor() {
    super();
  }

  public emitEvent(type: string, payload: any): void {
    this.emit(type, payload);
    this.emit('*', { type, payload });
  }
}

export const eventBus = new EventBus();
