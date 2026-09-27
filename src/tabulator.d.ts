declare module "tabulator-tables" {
  export interface CellComponent { getValue(): unknown; getField(): string; getRow(): { getData(): Record<string, unknown> }; }
  export class TabulatorFull {
    constructor(element: HTMLElement, options: Record<string, unknown>);
    on(event: string, callback: (cell: CellComponent) => void): void;
    destroy(): void;
  }
}
