import {
  ApolloLink,
  FetchResult,
  NextLink,
  Observable,
  Operation
} from "apollo-link";
import { hasDirectives } from "apollo-utilities";
import { Observer } from "zen-observable-ts";
import { PersistedData, PersistentStore } from "../PersistentStore";
import { localDirectives, MUTATION_QUEUE_LOGGER } from "../config/Constants";
import { NetworkInfo, NetworkStatus } from "../offline";
import { DataSyncConfig } from "../config";
import { squashOperations } from "../offline/squashOperations";
import * as debug from "debug";
import { OfflineQueueListener } from "../offline";

export const logger = debug.default(MUTATION_QUEUE_LOGGER);

export interface OperationQueueEntry {
  operation: Operation;
  forward: NextLink;
  observer: Observer<FetchResult>;
  subscription?: { unsubscribe: () => void };
  optimisticResponse?: any;
}

interface ForwardOptions {
  forward: NextLink;
  operation: Operation;
  observer: Observer<FetchResult>;
}

/**
 * Type used for filtering
 */
export type TYPE_MUTATION = "mutation" | "query";

/**
 * Apollo link implementation used to queue graphql requests.
 * When queue is open all requests are passing without any operation performed.
 * Closed queue will hold of requests until they are processed and persisting
 * them in supplied storage interface. Queue could open/close
 * depending on network state.
 *
 * @see OfflineQueueLink.openQueueOnNetworkStateUpdates
 */
export class OfflineQueueLink extends ApolloLink {
  private opQueue: OperationQueueEntry[] = [];
  private isOpen: boolean = true;
  private processingQueue: boolean = false;
  private storage: PersistentStore<PersistedData>;
  private readonly key: string;
  private readonly networkStatus?: NetworkStatus;
  private readonly operationFilter?: TYPE_MUTATION;
  private readonly mergeOfflineMutations?: boolean;
  private readonly listener?: OfflineQueueListener;
  /**
   *
   * @param config configuration for queue
   * @param filter
   */
  constructor(config: DataSyncConfig, filter?: TYPE_MUTATION) {
    super();
    this.storage = config.storage as PersistentStore<PersistedData>;
    this.key = config.mutationsQueueName;
    this.mergeOfflineMutations = config.mergeOfflineMutations;
    this.networkStatus = config.networkStatus;
    this.listener = config.offlineQueueListener;
    this.operationFilter = filter;
  }

  public get isQueueOpen() {
    return this.isOpen;
  }

  public async open() {
    logger("MutationQueue is open", this.opQueue);
    this.isOpen = true;
    await this.processQueue();
  }

  public async processQueue() {
    if (this.processingQueue) { return; }

    this.processingQueue = true;

    while (this.opQueue.length > 0) {
      try {
        const opEntry = this.opQueue[0];
        const result = await this.forwardOperation(this.opQueue[0]);

        this.updateIds(opEntry, result);
      } catch (_) {
        continue;
      }
    }

    this.processingQueue = false;

    if (this.listener && this.listener.queueCleared) {
      this.listener.queueCleared();
    }
  }

  public close() {
    logger("MutationQueue is closed");
    this.isOpen = false;
  }

  public request(operation: Operation, forward: NextLink) {
    if (!operation.variables.__enqueueMutation) {
      if (hasDirectives([localDirectives.ONLINE_ONLY], operation.query)) {
        logger("Online only request");
        return forward(operation);
      }
      if (this.shouldSkipOperation(operation, this.operationFilter)) {
        return forward(operation);
      }

      if (this.isOpen && this.opQueue.length === 0 && !this.processingQueue) {
        logger("Forwarding request");
        return this.forwardOrEnqueue(forward, operation);
      }
    }

    return new Observable(observer => {
      const operationEntry = this.enqueue({ operation, forward, observer });
      return () => this.cancelOperation(operationEntry);
    });
  }

  private forwardOrEnqueue(forward: NextLink, operation: Operation) {
    return new Observable(observer => {
      const forwardOptions = { forward, operation, observer };

      let operationEntry: OperationQueueEntry;

      const asyncForward = async () => {
        try {
          await this.forwardOperation(forwardOptions);
        } catch (error) {
          if (error.__networkError) {
            operation.variables.__processQueue = true;
            operationEntry = this.enqueue(forwardOptions);
          }
        }
      };

      asyncForward();

      return () => {
        if (operationEntry) { this.cancelOperation(operationEntry); }
      };
    });
  }

  private forwardOperation(options: ForwardOptions) {
    const { forward, operation, observer } = options;

    return new Promise((resolve, reject) => {
      forward(operation).subscribe({
        next: result => {
          resolve(result);
          if (observer.next) { observer.next(result); }
        },
        error: error => {
          if (operation.variables.__networkError) {
            delete operation.variables.__networkError;
            error.__networkError = true;
            reject(error);
          } else {
            reject(error);
            if (observer.error) { observer.error(error); }
          }
        },
        complete: () => {
          if (observer.complete) { observer.complete(); }
        }
      });
    });
  }

  private cancelOperation(entry: OperationQueueEntry) {
    this.opQueue = this.opQueue.filter(e => e !== entry);
    this.storage.setItem(this.key, JSON.stringify(this.opQueue));
  }

  private enqueue(forwardOptions: ForwardOptions): OperationQueueEntry {
    logger("Adding new operation to offline queue");
    const { forward, operation, observer } = forwardOptions;
    operation.variables.__offlineQueue = true;
    const optimisticResponse = operation.getContext().optimisticResponse;
    const entry = { operation, forward, observer, optimisticResponse };
    if (this.listener && this.listener.onOperationEnqueued) {
      this.listener.onOperationEnqueued(entry);
    }
    if (this.mergeOfflineMutations) {
      this.opQueue = squashOperations(entry, this.opQueue);
    } else {
      this.opQueue.push(entry);
    }
    this.storage.setItem(this.key, JSON.stringify(this.opQueue));
    if (this.isOpen && entry.operation.variables.__processQueue) {
      this.processQueue();
    }
    return entry;
  }

  private shouldSkipOperation(operation: Operation, filter?: string) {
    if (!filter) {
      return false;
    }
    return operation.query.definitions.filter((e) => {
      return (e as any).operation === filter;
    }).length === 0;
  }

  /**
   * Turns on queue to react to network state changes.
   * Requires network state implementation to be supplied in the configuration.
   */
  // tslint:disable-next-line:member-ordering
  public openQueueOnNetworkStateUpdates(): void {
    const self = this;
    if (this.networkStatus) {
      this.networkStatus.isOffline().then(offline => {
        if (offline) {
          this.close();
        } else {
          this.open();
        }
      });

      this.networkStatus.onStatusChangeListener({
        onStatusChange(networkInfo: NetworkInfo) {
          if (networkInfo.online) {
            self.open();
          } else {
            self.close();
          }
        }
      });
    }
  }

  private updateIds(
    operationEntry: OperationQueueEntry,
    result: FetchResult
  ): void {
    const operation = operationEntry.operation;
    const optimisticResponse = operationEntry.optimisticResponse;
    if (optimisticResponse && optimisticResponse[operation.operationName].__optimisticId) {
      const optimisticId = optimisticResponse[operation.operationName].id;
      this.opQueue.forEach(({ operation: op }) => {
        if (op.variables.id === optimisticId && result.data) {
          op.variables.id = result.data[operation.operationName].id;
        }
      });
      this.storage.setItem(this.key, JSON.stringify(this.opQueue));
    }
  }
}
