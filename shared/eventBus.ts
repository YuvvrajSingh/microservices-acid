import { DomainEvent } from './types';

export type EventHandler<T = any> = (event: DomainEvent<T>) => Promise<void> | void;
export type Unsubscribe = () => void;

export interface EventBusOptions {
  onError?: (error: unknown, event: DomainEvent<any>, topic: string) => void;
}

export interface EventBus {
  /**
   * Publishes an event to all matching subscribers.
   * Handlers are executed concurrently and settled safely.
   */
  publish<T = unknown>(event: DomainEvent<T>): Promise<void>;

  /**
   * Publishes an event in fire-and-forget mode without blocking the caller.
   */
  publishAsync<T = unknown>(event: DomainEvent<T>): void;

  /**
   * Subscribes a handler to a specific topic or pattern (e.g., 'order.created', 'order.*', '*').
   * Returns a cleanup function to unsubscribe.
   */
  subscribe<T = unknown>(topic: string, handler: EventHandler<T>): Unsubscribe;

  /**
   * Subscribes a handler to all events across all topics.
   * Returns a cleanup function to unsubscribe.
   */
  subscribeAll(handler: EventHandler<unknown>): Unsubscribe;

  /**
   * Explicitly removes a handler from a topic.
   */
  unsubscribe<T = unknown>(topic: string, handler: EventHandler<T>): void;

  /**
   * Returns the number of registered listeners for a specific topic or total listeners.
   */
  listenerCount(topic?: string): number;

  /**
   * Removes all registered handlers.
   */
  clear(): void;
}

/**
 * In-memory event bus providing pub/sub with async dispatch and topic subscriptions.
 * Supports exact topic matches, single-level prefix wildcards (e.g., 'order.*'),
 * and global wildcards ('*').
 */
export class InMemoryEventBus implements EventBus {
  private subscriptions: Map<string, Set<EventHandler<any>>> = new Map();
  private onError?: (error: unknown, event: DomainEvent<any>, topic: string) => void;

  constructor(options?: EventBusOptions) {
    this.onError = options?.onError;
  }

  /**
   * Match topic against subscription pattern.
   * - '*' matches all topics
   * - 'order.*' matches 'order.created', 'order.cancelled', etc.
   * - 'order.created' matches only 'order.created'
   */
  private matchesTopic(pattern: string, publishedTopic: string): boolean {
    if (pattern === '*' || pattern === publishedTopic) {
      return true;
    }

    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      return publishedTopic.startsWith(prefix + '.');
    }

    return false;
  }

  /**
   * Retrieves all handlers matching the published topic.
   */
  private getMatchingHandlers(publishedTopic: string): EventHandler<any>[] {
    const matching: EventHandler<any>[] = [];

    for (const [pattern, handlers] of this.subscriptions.entries()) {
      if (this.matchesTopic(pattern, publishedTopic)) {
        for (const handler of handlers) {
          matching.push(handler);
        }
      }
    }

    return matching;
  }

  /**
   * Publishes an event to matching subscribers and awaits completion of all handlers.
   * Subscriber execution is isolated: a failure in one handler does not abort others.
   */
  public async publish<T = unknown>(event: DomainEvent<T>): Promise<void> {
    const handlers = this.getMatchingHandlers(event.topic);
    if (handlers.length === 0) {
      return;
    }

    const tasks = handlers.map(async (handler) => {
      try {
        await handler(event);
      } catch (err) {
        if (this.onError) {
          this.onError(err, event, event.topic);
        } else {
          // Default error log if no custom handler is configured
          console.error(`[EventBus] Unhandled error in subscriber for topic "${event.topic}":`, err);
        }
      }
    });

    await Promise.allSettled(tasks);
  }

  /**
   * Publishes an event asynchronously without blocking the caller.
   */
  public publishAsync<T = unknown>(event: DomainEvent<T>): void {
    setImmediate(() => {
      this.publish(event).catch((err) => {
        console.error(`[EventBus] Async dispatch failure for topic "${event.topic}":`, err);
      });
    });
  }

  /**
   * Subscribes a handler to a topic or topic pattern.
   */
  public subscribe<T = unknown>(topic: string, handler: EventHandler<T>): Unsubscribe {
    if (!this.subscriptions.has(topic)) {
      this.subscriptions.set(topic, new Set());
    }

    const set = this.subscriptions.get(topic)!;
    set.add(handler as EventHandler<any>);

    return () => this.unsubscribe(topic, handler);
  }

  /**
   * Subscribes a handler to all events.
   */
  public subscribeAll(handler: EventHandler<unknown>): Unsubscribe {
    return this.subscribe('*', handler);
  }

  /**
   * Unsubscribes a specific handler from a topic.
   */
  public unsubscribe<T = unknown>(topic: string, handler: EventHandler<T>): void {
    const set = this.subscriptions.get(topic);
    if (set) {
      set.delete(handler as EventHandler<any>);
      if (set.size === 0) {
        this.subscriptions.delete(topic);
      }
    }
  }

  /**
   * Returns listener count for a specific topic or total registered subscriptions.
   */
  public listenerCount(topic?: string): number {
    if (topic) {
      const set = this.subscriptions.get(topic);
      return set ? set.size : 0;
    }

    let total = 0;
    for (const set of this.subscriptions.values()) {
      total += set.size;
    }
    return total;
  }

  /**
   * Clears all subscriptions.
   */
  public clear(): void {
    this.subscriptions.clear();
  }
}

// Global default singleton instance
export const eventBus = new InMemoryEventBus();

export default eventBus;
