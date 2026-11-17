import { DOCUMENT } from '@angular/common';
import {
  DestroyRef,
  Directive,
  ElementRef,
  HostListener,
  inject,
  input,
  output,
} from '@angular/core';

export interface SimpleCardMove {
  from: string;
  to: string;
}

/** Pointer-only drag from an explicit handle; ordinary card actions never initiate a drag. */
@Directive({ selector: '[appSimpleReorder]' })
export class SimpleReorderDirective {
  readonly appSimpleReorder = input.required<string>();
  readonly reordered = output<SimpleCardMove>();
  private readonly element = inject<ElementRef<HTMLButtonElement>>(ElementRef);
  private readonly document = inject(DOCUMENT);
  private drag: {
    pointer: number;
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
    from: string;
    group: string;
    list: HTMLElement;
    source: HTMLElement;
    target: HTMLElement | null;
    ghost: HTMLElement | null;
  } | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.cancel());
  }

  @HostListener('pointerdown', ['$event'])
  start(event: PointerEvent): void {
    if (event.button !== 0 || event.isPrimary === false) return;
    this.cancel();
    const source = this.element.nativeElement.closest<HTMLElement>('[data-order-key]');
    const list = source?.closest<HTMLElement>('[data-order-group]');
    if (!source || !list) return;
    const rect = source.getBoundingClientRect();
    this.drag = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      from: this.appSimpleReorder(),
      group: list.dataset['orderGroup'] ?? '',
      list,
      source,
      target: null,
      ghost: null,
    };
    this.element.nativeElement.setPointerCapture?.(event.pointerId);
  }

  @HostListener('document:pointermove', ['$event'])
  move(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointer) return;
    if (!this.valid()) {
      this.cancel();
      return;
    }
    if (!drag.ghost && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8) return;
    event.preventDefault();
    if (!drag.ghost) {
      const ghost = drag.source.cloneNode(true) as HTMLElement;
      ghost.removeAttribute('id');
      ghost.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
      ghost.inert = true;
      ghost.setAttribute('aria-hidden', 'true');
      ghost.classList.add('simple-order-ghost');
      // Material card styles are injected later and otherwise replace fixed with relative.
      ghost.style.position = 'fixed';
      ghost.style.width = drag.width + 'px';
      ghost.style.height = drag.height + 'px';
      ghost.style.font = this.document.defaultView?.getComputedStyle(drag.source).font ?? '';
      drag.source.setAttribute('data-order-source', 'true');
      this.document.documentElement.setAttribute('data-simple-order-dragging', 'true');
      this.document.body.appendChild(ghost);
      drag.ghost = ghost;
    }
    const viewport = this.document.documentElement;
    const width = viewport.clientWidth || this.document.defaultView?.innerWidth || drag.width;
    const height = viewport.clientHeight || this.document.defaultView?.innerHeight || drag.height;
    // Keep the grabbed point under the pointer; clamp at viewport edges without shrinking.
    const left = Math.max(0, Math.min(event.clientX - drag.offsetX, width - drag.width));
    const top = Math.max(0, Math.min(event.clientY - drag.offsetY, height - drag.height));
    drag.ghost.style.transform = `translate(${left}px, ${top}px)`;
    drag.target?.removeAttribute('data-order-target');
    const target =
      this.document
        .elementFromPoint?.(event.clientX, event.clientY)
        ?.closest<HTMLElement>('[data-order-key]') ?? null;
    drag.target =
      target?.closest('[data-order-group]') === drag.list && target !== drag.source ? target : null;
    drag.target?.setAttribute('data-order-target', 'true');
  }

  @HostListener('document:pointerup', ['$event'])
  finish(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointer) return;
    const target =
      drag.ghost && this.valid() && drag.target?.isConnected
        ? drag.target.dataset['orderKey']
        : null;
    const from = drag.from;
    this.cancel();
    if (target && from !== target) this.reordered.emit({ from, to: target });
  }

  @HostListener('lostpointercapture')
  @HostListener('document:pointercancel')
  @HostListener('window:blur')
  @HostListener('window:resize')
  cancel(): void {
    const drag = this.drag;
    this.drag = null;
    drag?.target?.removeAttribute('data-order-target');
    drag?.ghost?.remove();
    drag?.source.removeAttribute('data-order-source');
    if (drag?.ghost) this.document.documentElement.removeAttribute('data-simple-order-dragging');
    if (drag && this.element.nativeElement.hasPointerCapture?.(drag.pointer))
      this.element.nativeElement.releasePointerCapture(drag.pointer);
  }

  @HostListener('document:keydown', ['$event'])
  escape(event: KeyboardEvent): void {
    if (event.key === 'Escape') this.cancel();
  }

  @HostListener('keydown', ['$event'])
  keyboard(event: KeyboardEvent): void {
    const delta = ['ArrowUp', 'ArrowLeft'].includes(event.key)
      ? -1
      : ['ArrowDown', 'ArrowRight'].includes(event.key)
        ? 1
        : 0;
    if (!delta) return;
    event.preventDefault();
    const source = this.element.nativeElement.closest<HTMLElement>('[data-order-key]');
    const list = source?.closest<HTMLElement>('[data-order-group]');
    if (!source || !list) return;
    const cards = Array.from(list.querySelectorAll<HTMLElement>('[data-order-key]')).filter(
      card => card.closest('[data-order-group]') === list
    );
    const target = cards[cards.indexOf(source) + delta]?.dataset['orderKey'];
    if (target) this.reordered.emit({ from: this.appSimpleReorder(), to: target });
  }

  private valid(): boolean {
    const drag = this.drag;
    return (
      !!drag &&
      drag.source.isConnected &&
      drag.list.isConnected &&
      drag.source.closest('[data-order-group]') === drag.list &&
      drag.list.dataset['orderGroup'] === drag.group &&
      drag.from === this.appSimpleReorder()
    );
  }
}
