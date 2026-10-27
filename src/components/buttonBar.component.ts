import { Component, OnInit, OnDestroy, HostBinding, HostListener, ElementRef, ViewChild } from '@angular/core'
import {
    AppService,
    BaseComponent,
    BaseTabComponent,
    ConfigService,
    HostAppService,
    Platform,
    PlatformService,
    SplitTabComponent,
} from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import path from 'node:path'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { Subject, Subscription } from 'rxjs'
import { takeUntil } from 'rxjs/operators'

export interface ButtonWait {
    /** Substring or regular expression to wait for in the terminal output. */
    pattern: string
    /** Timeout in seconds (default 30). */
    timeout?: number
}

export interface ButtonCommand {
    id: string
    label: string
    command: string
    color?: string
    icon?: string
    tooltip?: string
    sendEnter?: boolean
    /** waits[i] applies before sending line i+1 of a multi-line command. */
    waits?: (ButtonWait | null)[]
}

export interface ButtonList {
    id: string
    name: string
    buttons: ButtonCommand[]
}

interface ButtonBarStorage {
    lists: ButtonList[]
    activeListId?: string
}

@Component({
    selector: 'button-bar',
    template: `
        <div class="button-bar-container" [class.collapsed]="collapsed">
            <div class="button-bar-main" *ngIf="!collapsed">
                <div class="list-selector">
                    <button class="list-toggle" #listToggleButton (click)="toggleListMenu($event)">
                        <span>{{ activeList?.name || 'Lists' }}</span>
                        <i class="fas fa-caret-down"></i>
                    </button>
                    <div class="list-menu" #listMenu *ngIf="listMenuVisible" [ngStyle]="listMenuStyles">
                        <div class="list-menu-header">
                            <span>Lists</span>
                            <button class="btn-link btn-sm" (click)="createList($event)" title="New list">+</button>
                        </div>
                        <ng-container *ngFor="let list of lists; let i = index">
                            <div class="list-menu-item" [class.active]="list.id === activeListId">
                                <button class="list-item-name" (click)="setActiveList(list.id)">
                                    {{ list.name }}
                                </button>
                                <div class="list-item-actions">
                                    <button title="Rename" (click)="renameList($event, list)">✎</button>
                                    <button title="Duplicate" (click)="duplicateList($event, list)">⧉</button>
                                    <button title="Delete" (click)="deleteList($event, list)" [disabled]="lists.length === 1">🗑</button>
                                </div>
                            </div>
                        </ng-container>
                        <div class="list-menu-footer">
                            <button class="btn-link btn-sm" (click)="openEditLists($event)">
                                <i class="fas fa-list"></i> Edit lists
                            </button>
                            <button class="btn-link btn-sm" (click)="openImportExportModal($event)">
                                <i class="fas fa-cog"></i> Import/Export
                            </button>
                        </div>
                    </div>
                </div>
                <div class="button-bar-buttons">
                    <ng-container *ngIf="activeList">
                        <button *ngFor="let btn of activeList.buttons; trackBy: trackByButton"
                                class="cmd-btn"
                                tabindex="-1"
                                [class.dragging]="draggingButton === btn"
                                [attr.data-btn-id]="btn.id"
                                [style.--btn-color]="btn.color || '#4a4a4a'"
                                [title]="btn.tooltip || btn.command"
                                (click)="executeCommand(btn, $event)"
                                (pointerdown)="onButtonPointerDown($event, btn)"
                                (contextmenu)="onButtonContextMenu($event, btn)">
                            <i *ngIf="btn.icon" class="fas" [ngClass]="'fa-' + btn.icon"></i>
                            <span>{{ btn.label }}</span>
                        </button>
                    </ng-container>
                    <button class="cmd-btn cmd-btn-add" (click)="openAddModal()" title="Add command">
                        <i class="fas fa-plus"></i>
                    </button>
                </div>
                <div class="button-bar-actions">
                    <button class="action-btn" (click)="collapse()" title="Collapse button bar">
                        <i class="fas fa-chevron-down"></i>
                    </button>
                </div>
            </div>
            <button *ngIf="collapsed" class="expand-btn" (click)="expand()" title="Expand button bar">
                <i class="fas fa-chevron-up"></i>
            </button>
        </div>

        <!-- Add/Edit Command Modal -->
        <div class="modal-backdrop" *ngIf="modalVisible" (click)="closeModal()"></div>
        <div class="command-modal" *ngIf="modalVisible">
            <div class="modal-header">
                <h5>{{ editingButton ? 'Edit Command' : 'Add Command' }}</h5>
                <button class="btn btn-link" (click)="closeModal()">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body">
                <div class="form-group mb-3">
                    <label class="form-label">Label</label>
                    <input type="text" class="form-control" [(ngModel)]="modalData.label" placeholder="e.g., List Files">
                </div>
                <div class="form-group mb-3">
                    <label class="form-label">Command <small class="text-muted">(one command per line)</small></label>
                    <textarea class="form-control command-textarea" rows="3"
                              [ngModel]="modalData.command"
                              (ngModelChange)="onCommandInput($event)"
                              placeholder="e.g., adb push ...  (new line)  adb shell ..."></textarea>
                </div>
                <div class="form-group mb-3" *ngIf="modalWaitRows.length > 0">
                    <label class="form-label">Wait for output before next line <small class="text-muted">(optional)</small></label>
                    <div class="wait-row" *ngFor="let wait of modalWaitRows; let i = index">
                        <span class="wait-line-label">Line {{ i + 2 }}</span>
                        <input type="text" class="form-control wait-pattern"
                               [(ngModel)]="wait.pattern"
                               placeholder="text or regex, e.g. Password: / 100%">
                        <input type="number" class="form-control wait-timeout"
                               [(ngModel)]="wait.timeout" min="1" placeholder="30">
                        <span class="wait-timeout-unit">s</span>
                    </div>
                    <small class="text-muted">
                        The next line is sent only after terminal output matches (substring or regex).
                        Timeout aborts the remaining lines (default 30s).
                    </small>
                </div>
                <div class="form-group mb-3">
                    <label class="form-label">Icon (FontAwesome name, optional)</label>
                    <input type="text" class="form-control" [(ngModel)]="modalData.icon" placeholder="e.g., folder, server, code">
                </div>
                <div class="form-group mb-3">
                    <label class="form-label">Color (optional)</label>
                    <div class="color-picker">
                        <button *ngFor="let color of presetColors"
                                class="color-option"
                                [style.background]="color"
                                [class.selected]="modalData.color === color"
                                (click)="modalData.color = color">
                        </button>
                        <input type="color" [(ngModel)]="modalData.color" class="color-input">
                    </div>
                </div>
                <div class="form-group mb-3">
                    <label class="form-label">Tooltip (optional)</label>
                    <input type="text" class="form-control" [(ngModel)]="modalData.tooltip" placeholder="Description shown on hover">
                </div>
                <div class="form-check mb-3">
                    <input type="checkbox" class="form-check-input" id="sendEnter" [(ngModel)]="modalData.sendEnter">
                    <label class="form-check-label" for="sendEnter">Send Enter after command</label>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" (click)="closeModal()">Cancel</button>
                <button class="btn btn-primary" (click)="saveButton()" [disabled]="!modalData.label || !modalData.command">
                    {{ editingButton ? 'Save' : 'Add' }}
                </button>
            </div>
        </div>

        <!-- Context Menu -->
        <div class="context-menu"
             #contextMenu
             *ngIf="contextMenuVisible"
             [ngStyle]="contextMenuStyles">
            <div class="context-menu-item" (click)="contextMenuEdit()">
                <i class="fas fa-fw fa-edit"></i>
                <span>Edit</span>
            </div>
            <div class="context-menu-item" (click)="contextMenuDuplicate()">
                <i class="fas fa-fw fa-copy"></i>
                <span>Duplicate</span>
            </div>
            <div class="context-menu-item" (click)="openMoveCopyModal('move')">
                <i class="fas fa-fw fa-arrow-right"></i>
                <span>Move to list</span>
            </div>
            <div class="context-menu-item" (click)="openMoveCopyModal('copy')">
                <i class="fas fa-fw fa-clone"></i>
                <span>Copy to list</span>
            </div>
            <div class="context-menu-divider"></div>
            <div class="context-menu-item context-menu-item-danger" (click)="contextMenuDelete()">
                <i class="fas fa-fw fa-trash-alt"></i>
                <span>Delete</span>
            </div>
        </div>

        <!-- Move / Copy to List Modal -->
        <div class="modal-backdrop" *ngIf="moveCopyModalVisible" (click)="closeMoveCopyModal()"></div>
        <div class="command-modal" *ngIf="moveCopyModalVisible">
            <div class="modal-header">
                <h5>{{ moveCopyMode === 'move' ? 'Move to List' : 'Copy to List' }}</h5>
                <button class="btn btn-link" (click)="closeMoveCopyModal()">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body">
                <div class="move-copy-source" *ngIf="moveCopyButton">{{ moveCopyButton.label }}</div>
                <div class="list-choice-list">
                    <button *ngFor="let list of lists"
                            class="btn btn-secondary list-choice"
                            [disabled]="list.id === moveCopySourceListId"
                            (click)="applyMoveCopy(list)">
                        <span>{{ list.name }}</span>
                        <small>{{ list.buttons.length }} buttons</small>
                    </button>
                </div>
                <p class="text-muted" *ngIf="lists.length <= 1">Create another list first.</p>
            </div>
        </div>

        <!-- Edit Lists Modal -->
        <div class="modal-backdrop" *ngIf="editListsVisible" (click)="closeEditLists()"></div>
        <div class="edit-lists-modal" *ngIf="editListsVisible">
            <div class="modal-header">
                <h5>Edit Lists</h5>
                <button class="btn btn-link" (click)="closeEditLists()">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body edit-lists-body">
                <p class="edit-lists-hint text-muted">
                    Drag a button onto another list to <strong>Copy</strong> or <strong>Move</strong> it.
                    Drag it between buttons of the same list to reorder.
                </p>
                <div class="edit-list-section"
                     *ngFor="let list of lists"
                     (dragover)="onEditListDragOver(list, $event)"
                     (dragleave)="onEditListDragLeave(list, $event)">
                    <div class="edit-list-title">
                        <strong>{{ list.name }}</strong>
                        <span class="edit-list-count">{{ list.buttons.length }}</span>
                    </div>
                    <div class="edit-list-buttons">
                        <div class="edit-button-row"
                             *ngFor="let btn of list.buttons; trackBy: trackByButton"
                             draggable="true"
                             [class.drop-before]="isEditRowDropTarget(list, btn, 'before')"
                             [class.drop-after]="isEditRowDropTarget(list, btn, 'after')"
                             (dragstart)="onEditButtonDragStart(list, btn, $event)"
                             (dragend)="onEditButtonDragEnd()"
                             (dragover)="onEditRowDragOver(list, btn, $event)"
                             (dragleave)="onEditRowDragLeave(list, btn, $event)"
                             (drop)="onEditRowDrop(list, btn, $event)">
                            <i *ngIf="btn.icon" class="fas" [ngClass]="'fa-' + btn.icon"></i>
                            <span class="edit-button-label">{{ btn.label }}</span>
                            <small class="edit-button-command">{{ btn.command }}</small>
                        </div>
                        <div *ngIf="list.buttons.length === 0" class="text-muted edit-list-empty">
                            No buttons
                        </div>
                    </div>
                    <div class="edit-drop-overlay" *ngIf="isEditDropTarget(list)">
                        <div class="edit-drop-zone edit-drop-copy"
                             (dragover)="$event.preventDefault(); $event.stopPropagation()"
                             (drop)="dropEditButton(list, 'copy', $event)">
                            <i class="fas fa-clone"></i>
                            <span>Copy here</span>
                        </div>
                        <div class="edit-drop-zone edit-drop-move"
                             (dragover)="$event.preventDefault(); $event.stopPropagation()"
                             (drop)="dropEditButton(list, 'move', $event)">
                            <i class="fas fa-arrow-right"></i>
                            <span>Move here</span>
                        </div>
                    </div>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" (click)="closeEditLists()">Close</button>
            </div>
        </div>

        <!-- Import/Export Modal -->
        <div class="modal-backdrop" *ngIf="importExportModalVisible" (click)="closeImportExportModal()"></div>
        <div class="command-modal" *ngIf="importExportModalVisible">
            <div class="modal-header">
                <h5>Import / Export Lists</h5>
                <button class="btn btn-link" (click)="closeImportExportModal()">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body">
                <textarea class="form-control" rows="10" [(ngModel)]="listsJson" placeholder="Paste JSON here to import, or click Export"></textarea>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" (click)="exportLists()">Export</button>
                <button class="btn btn-primary" (click)="importLists()">Import</button>
            </div>
        </div>

        <!-- List Name Modal (Create/Rename) -->
        <div class="modal-backdrop" *ngIf="listNameModalVisible" (click)="closeListNameModal()"></div>
        <div class="command-modal" *ngIf="listNameModalVisible">
            <div class="modal-header">
                <h5>{{ editingList ? 'Rename List' : 'New List' }}</h5>
                <button class="btn btn-link" (click)="closeListNameModal()">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body">
                <div class="form-group">
                    <label class="form-label">List Name</label>
                    <input type="text" class="form-control" [(ngModel)]="listNameInput" placeholder="e.g., Cisco, Huawei" (keyup.enter)="saveListName()">
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" (click)="closeListNameModal()">Cancel</button>
                <button class="btn btn-primary" (click)="saveListName()" [disabled]="!listNameInput?.trim()">
                    {{ editingList ? 'Save' : 'Create' }}
                </button>
            </div>
        </div>

        <!-- Delete Confirmation Modal -->
        <div class="modal-backdrop" *ngIf="deleteConfirmVisible" (click)="closeDeleteConfirm()"></div>
        <div class="command-modal" *ngIf="deleteConfirmVisible">
            <div class="modal-header">
                <h5>Delete List</h5>
                <button class="btn btn-link" (click)="closeDeleteConfirm()">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="modal-body">
                <p>Are you sure you want to delete "<strong>{{ listToDelete?.name }}</strong>"?</p>
                <p class="text-muted">This will remove all commands in this list.</p>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" (click)="closeDeleteConfirm()">Cancel</button>
                <button class="btn btn-danger" (click)="confirmDeleteList()">Delete</button>
            </div>
        </div>
    `,
    styles: [`
        :host {
            display: block;
            width: 100%;
            pointer-events: auto;
        }

        .button-bar-container {
            width: 100%;
            background: var(--bs-tertiary-bg, #232323);
            border-top: 1px solid var(--bs-border-color, #404040);
            padding: 4px 6px;
            display: flex;
            justify-content: center;
        }

        :host.platform-mac .button-bar-container {
            padding: 6px 12px;
        }

        :host.platform-windows .button-bar-container {
            padding: 4px 8px;
        }

        :host.platform-linux .button-bar-container {
            padding: 6px 6px;
        }

        .button-bar-container.collapsed {
            padding: 2px 6px;
            justify-content: flex-end;
        }

        .expand-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 30px;
            height: 16px;
            padding: 0;
            background: transparent;
            border: 1px solid transparent;
            border-radius: 4px;
            color: var(--bs-secondary-color, #888);
            cursor: pointer;
            font-size: 10px;
        }

        .expand-btn:hover {
            border-color: var(--bs-border-color, #555);
            color: var(--bs-body-color, #e0e0e0);
            background: rgba(255,255,255,0.05);
        }

        .button-bar-main {
            width: 100%;
            max-width: 100%;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .list-selector {
            position: relative;
        }

        .list-toggle {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 2px 10px;
            border-radius: 4px;
            border: 1px solid transparent;
            background: var(--bs-body-bg, #1f1f1f);
            color: var(--bs-body-color, #e0e0e0);
            cursor: pointer;
            font-size: 12px;
        }

        .list-toggle:hover {
            border-color: var(--bs-border-color, #555);
        }

        .list-menu {
            position: absolute;
            bottom: 110%;
            top: auto;
            left: 0;
            min-width: 240px;
            background: var(--bs-body-bg, #1d1d1d);
            border: 1px solid var(--bs-border-color, #444);
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
            padding: 6px;
            z-index: 10001;
            display: flex;
            flex-direction: column;
            gap: 4px;
            overflow-y: auto;
            max-height: 300px;
            box-sizing: border-box;
        }

        .list-menu-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 6px;
            font-size: 11px;
            font-weight: 600;
            color: var(--bs-secondary-color, #888);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            border-bottom: 1px solid var(--bs-border-color, #444);
            margin-bottom: 4px;
        }

        .list-menu-header .btn-sm {
            font-size: 16px;
            padding: 0 4px;
            line-height: 1;
        }

        .list-menu-footer {
            border-top: 1px solid var(--bs-border-color, #444);
            margin-top: 4px;
            padding-top: 6px;
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 4px;
        }

        .list-menu-footer .btn-sm {
            font-size: 11px;
            color: var(--bs-secondary-color, #888);
        }

        .list-menu-footer .btn-sm:hover {
            color: var(--bs-body-color, #e0e0e0);
        }

        .list-menu-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 6px;
            border-radius: 4px;
            background: transparent;
        }

        .list-menu-item.active {
            background: rgba(255, 255, 255, 0.08);
        }

        .list-item-name {
            background: none;
            border: none;
            padding: 0;
            color: var(--bs-body-color, #e0e0e0);
            font-size: 13px;
            cursor: pointer;
            text-align: left;
            flex: 1;
        }

        .list-item-name:hover {
            color: var(--bs-primary, #0d6efd);
        }

        .list-item-actions {
            display: flex;
            gap: 2px;
        }

        .list-item-actions button {
            border: none;
            background: none;
            color: var(--bs-secondary-color, #888);
            cursor: pointer;
            padding: 2px 4px;
            font-size: 12px;
        }

        .list-item-actions button:hover:not(:disabled) {
            color: var(--bs-body-color, #e0e0e0);
        }

        .list-item-actions button:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }

        .button-bar-buttons {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            flex: 1;
            justify-content: flex-start;
            align-content: flex-start;
            max-height: min(84px, 24vh);
            overflow-y: auto;
            overscroll-behavior: contain;
            padding-right: 2px;
        }

        .cmd-btn {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 2px 10px;
            font-size: 11px;
            font-weight: 500;
            color: var(--bs-body-color, #e0e0e0);
            background: var(--btn-color, #4a4a4a);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.15s ease;
            white-space: nowrap;
            height: 26px;
        }

        .cmd-btn i {
            font-size: 10px;
        }

        .cmd-btn:hover {
            filter: brightness(1.15);
            border-color: rgba(255,255,255,0.2);
        }

        .cmd-btn.dragging {
            opacity: 0.35;
            outline: 1px dashed var(--bs-primary, #0d6efd);
            pointer-events: none;
        }

        .cmd-btn-add {
            background: transparent;
            border: 1px dashed var(--bs-border-color, #555);
            color: var(--bs-secondary-color, #888);
            padding: 2px 6px;
        }

        .cmd-btn-add:hover {
            border-style: solid;
            color: var(--bs-body-color, #e0e0e0);
        }

        .button-bar-actions {
            display: flex;
        }

        .action-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 22px;
            height: 22px;
            padding: 0;
            background: transparent;
            border: 1px solid transparent;
            border-radius: 4px;
            color: var(--bs-secondary-color, #888);
            cursor: pointer;
        }

        .action-btn:hover {
            border-color: var(--bs-border-color, #555);
            color: var(--bs-body-color, #e0e0e0);
            background: rgba(255,255,255,0.05);
        }

        .modal-backdrop {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.5);
            z-index: 10000;
        }

        .command-modal {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: var(--bs-body-bg);
            border: 1px solid var(--bs-border-color);
            border-radius: 8px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.3);
            z-index: 10001;
            width: min(420px, 90vw);
            max-height: calc(100vh - 32px);
            overflow-y: auto;
            box-sizing: border-box;
        }

        .modal-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 16px;
            border-bottom: 1px solid var(--bs-border-color);
        }

        .modal-body {
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .form-label {
            font-size: 12px;
            font-weight: 500;
            margin-bottom: 4px;
        }

        .form-control {
            font-size: 13px;
        }

        .command-textarea {
            font-family: var(--bs-font-monospace, monospace);
            min-height: 64px;
            resize: vertical;
        }

        .wait-row {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-bottom: 6px;
        }

        .wait-line-label {
            flex: 0 0 52px;
            font-size: 11px;
            opacity: 0.7;
        }

        .wait-pattern {
            flex: 1 1 auto;
            min-width: 0;
        }

        .wait-timeout {
            flex: 0 0 64px;
        }

        .wait-timeout-unit {
            font-size: 11px;
            opacity: 0.7;
        }

        .color-picker {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-wrap: wrap;
        }

        .color-option {
            width: 20px;
            height: 20px;
            border-radius: 3px;
            border: 2px solid transparent;
            cursor: pointer;
            transition: all 0.2s ease;
        }

        .color-option:hover {
            transform: scale(1.1);
        }

        .color-option.selected {
            border-color: white;
            box-shadow: 0 0 0 2px var(--bs-primary);
        }

        .color-input {
            width: 28px;
            height: 20px;
            border: none;
            border-radius: 3px;
            cursor: pointer;
        }

        .modal-footer {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            padding: 12px 16px;
            border-top: 1px solid var(--bs-border-color);
        }

        .move-copy-source {
            font-size: 13px;
            font-weight: 600;
            padding: 6px 8px;
            border-radius: 4px;
            background: var(--bs-tertiary-bg);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .list-choice-list {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin-top: 8px;
        }

        .list-choice {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            text-align: left;
        }

        .list-choice small {
            opacity: 0.7;
        }

        .edit-lists-modal {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: min(960px, 92vw);
            max-height: 82vh;
            display: flex;
            flex-direction: column;
            background: var(--bs-body-bg);
            border: 1px solid var(--bs-border-color);
            border-radius: 8px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.3);
            z-index: 10001;
            box-sizing: border-box;
        }

        .edit-lists-body {
            display: flex;
            flex-direction: row;
            flex-wrap: wrap;
            align-items: flex-start;
            flex: 1 1 auto;
            gap: 12px;
            overflow-y: auto;
            min-height: 0;
        }

        .edit-lists-hint {
            flex: 0 0 100%;
            margin: 0 0 4px;
            font-size: 12px;
        }

        .edit-list-section {
            position: relative;
            flex: 1 1 260px;
            min-width: 240px;
            max-width: 460px;
            border: 1px solid var(--bs-border-color);
            border-radius: 8px;
            padding: 10px;
            background: var(--bs-tertiary-bg, #232323);
            box-sizing: border-box;
        }

        .edit-list-title {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin-bottom: 8px;
            font-size: 12px;
        }

        .edit-list-count {
            min-width: 20px;
            padding: 0 6px;
            border-radius: 10px;
            background: rgba(255,255,255,0.12);
            text-align: center;
            font-size: 11px;
        }

        .edit-list-buttons {
            display: flex;
            flex-direction: column;
            gap: 4px;
            min-height: 32px;
        }

        .edit-button-row {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 5px 8px;
            border: 1px solid var(--bs-border-color);
            border-radius: 4px;
            background: var(--bs-body-bg);
            cursor: grab;
            user-select: none;
            font-size: 12px;
        }

        .edit-button-row:active {
            cursor: grabbing;
        }

        .edit-button-row.drop-before {
            box-shadow: inset 0 2px 0 var(--bs-primary, #0d6efd);
        }

        .edit-button-row.drop-after {
            box-shadow: inset 0 -2px 0 var(--bs-primary, #0d6efd);
        }

        .edit-button-label {
            font-weight: 500;
            white-space: nowrap;
        }

        .edit-button-command {
            margin-left: auto;
            max-width: 55%;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            opacity: 0.65;
        }

        .edit-list-empty {
            font-size: 11px;
            padding: 4px 2px;
        }

        .edit-drop-overlay {
            position: absolute;
            inset: 0;
            display: flex;
            gap: 6px;
            padding: 8px;
            background: rgba(0, 0, 0, 0.72);
            border-radius: 8px;
            z-index: 2;
        }

        .edit-drop-zone {
            flex: 1;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 6px;
            border: 2px dashed;
            border-radius: 6px;
            font-size: 12px;
            font-weight: 600;
            cursor: copy;
        }

        .edit-drop-zone:hover {
            background: rgba(255,255,255,0.08);
        }

        .edit-drop-copy {
            border-color: #0d6efd;
            color: #6ea8fe;
        }

        .edit-drop-move {
            border-color: #198754;
            color: #75b798;
        }

        .context-menu {
            position: fixed;
            background: var(--bs-body-bg);
            border: 1px solid var(--bs-border-color);
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 10002;
            min-width: 140px;
            max-width: calc(100vw - 16px);
            box-sizing: border-box;
            padding: 4px 0;
            font-size: 12px;
        }

        .context-menu-item {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 6px 12px;
            cursor: pointer;
            transition: background 0.2s ease;
            color: var(--bs-body-color);
        }

        .context-menu-item:hover {
            background: var(--bs-tertiary-bg);
        }

        .context-menu-item-danger {
            color: var(--bs-danger);
        }

        .context-menu-item-danger:hover {
            background: var(--bs-danger);
            color: white;
        }

        .context-menu-divider {
            height: 1px;
            background: var(--bs-border-color);
            margin: 4px 0;
        }

        @media (max-width: 768px) {
            .button-bar-main {
                flex-wrap: wrap;
            }

            .button-bar-buttons {
                justify-content: center;
            }

            .list-menu {
                min-width: 200px;
            }
        }
    `]
})
export class ButtonBarComponent extends BaseComponent implements OnInit, OnDestroy {
    @HostBinding('class.button-bar') hostClass = true
    @HostBinding('class.platform-mac') get hostClassMac() { return this.hostApp.platform === Platform.macOS }
    @HostBinding('class.platform-windows') get hostClassWindows() { return this.hostApp.platform === Platform.Windows }
    @HostBinding('class.platform-linux') get hostClassLinux() { return this.hostApp.platform === Platform.Linux }

    lists: ButtonList[] = []
    activeListId = ''
    isMacOS = false

    // Modal state
    modalVisible = false
    modalData: Partial<ButtonCommand> & { sendEnter?: boolean } = {}
    modalWaitRows: { pattern: string; timeout?: number }[] = []
    editingButton: ButtonCommand | null = null

    // Context menu state
    contextMenuVisible = false
    contextMenuStyles: Record<string, string> = {}
    contextMenuButton: ButtonCommand | null = null
    private contextMenuAnchor: DOMRect | null = null

    // Collapse state (collapses to a slim strip with an expand button)
    collapsed = false

    // Drag-to-reorder state (long press, then drag)
    draggingButton: ButtonCommand | null = null
    private pendingDragButton: ButtonCommand | null = null
    private longPressTimer: ReturnType<typeof setTimeout> | null = null
    private pointerStart = { x: 0, y: 0 }
    private dragArmed = false
    private dragMoved = false
    private suppressClick = false

    // List menu state
    listMenuVisible = false
    listMenuStyles: Record<string, string> = {}

    // Move/Copy to list modal
    moveCopyModalVisible = false
    moveCopyMode: 'move' | 'copy' = 'move'
    moveCopyButton: ButtonCommand | null = null
    moveCopySourceListId = ''

    // Edit Lists modal (drag buttons between lists)
    editListsVisible = false
    editDragButton: ButtonCommand | null = null
    editDragSourceListId = ''
    editDragOverListId: string | null = null
    editDragRowId: string | null = null
    editDragRowPosition: 'before' | 'after' = 'before'

    // Import/Export modal
    importExportModalVisible = false
    listsJson = ''

    // List name modal (create/rename)
    listNameModalVisible = false
    listNameInput = ''
    editingList: ButtonList | null = null

    // Delete confirmation modal
    deleteConfirmVisible = false
    listToDelete: ButtonList | null = null

    @ViewChild('listToggleButton', { read: ElementRef }) private listToggleButton?: ElementRef<HTMLElement>
    @ViewChild('listMenu', { read: ElementRef }) private listMenuElement?: ElementRef<HTMLElement>
    @ViewChild('contextMenu', { read: ElementRef }) private contextMenuElement?: ElementRef<HTMLElement>

    get activeList(): ButtonList | undefined {
        return this.lists.find(l => l.id === this.activeListId) || this.lists[0]
    }

    presetColors = [
        '#4a4a4a',
        '#0d6efd',
        '#198754',
        '#dc3545',
        '#ffc107',
        '#0dcaf0',
        '#6f42c1',
        '#fd7e14',
    ]

    private destroy$ = new Subject<void>()
    private lastTerminalTab: BaseTerminalTabComponent<any> | null = null
    private lastConfigSnapshot = ''
    private storagePath?: string | null
    public barService: any = null

    constructor(
        private app: AppService,
        private config: ConfigService,
        private hostApp: HostAppService,
        private platformService: PlatformService,
    ) {
        super()
        this.isMacOS = this.hostApp.platform === Platform.macOS
    }

    @HostListener('document:click', ['$event'])
    onDocumentClick(_event: MouseEvent): void {
        // Context menu closing is handled on primary pointerdown. Closing it
        // from "click" made a plain right-click flash the menu closed: in some
        // environments a secondary click can produce a synthetic click event
        // after 'contextmenu'.
        this.closeListMenu()
    }

    @HostListener('document:pointerdown', ['$event'])
    onDocumentPointerDown(event: PointerEvent): void {
        if (event.button !== 0 || !this.contextMenuVisible) {
            return
        }
        if (this.contextMenuElement?.nativeElement.contains(event.target as Node)) {
            return
        }
        this.closeContextMenu()
    }

    @HostListener('document:keydown.escape')
    onEscape(): void {
        this.closeContextMenu()
        this.closeListMenu()
    }

    private closeContextMenu(): void {
        this.contextMenuVisible = false
        this.contextMenuStyles = {}
        this.contextMenuAnchor = null
    }

    ngOnInit(): void {
        this.loadLists()

        this.lastConfigSnapshot = this.configSnapshot()

        this.config.changed$
            .pipe(takeUntil(this.destroy$))
            .subscribe(() => {
                // Only reload when the button-bar part of the config actually
                // changed. This also prevents the save -> changed$ -> reload
                // loop the old skipNextConfigReload flag tried to avoid.
                const snapshot = this.configSnapshot()
                if (snapshot === this.lastConfigSnapshot) {
                    return
                }
                this.lastConfigSnapshot = snapshot
                this.loadLists()
            })

        const activeTerminal = this.findTerminalTab(this.app.activeTab)
        if (activeTerminal) {
            this.lastTerminalTab = activeTerminal
        }

        // Track terminal tab changes
        this.app.activeTabChange$
            .pipe(takeUntil(this.destroy$))
            .subscribe(tab => {
                const terminal = this.findTerminalTab(tab)
                if (terminal) {
                    this.lastTerminalTab = terminal
                }
            })
    }

    ngOnDestroy(): void {
        this.destroy$.next()
        this.destroy$.complete()
    }

    loadLists(): void {
        const pluginConfig = this.config.store.pluginConfig?.['button-bar'] || {}

        // Migration from old format (profiles with groups)
        if (pluginConfig.profiles?.length) {
            const oldProfiles = pluginConfig.profiles
            // Convert old profiles.groups to new lists format
            // Each old "group" becomes a new "list"
            const migratedLists: ButtonList[] = []
            for (const profile of oldProfiles) {
                if (profile.groups?.length) {
                    for (const group of profile.groups) {
                        migratedLists.push({
                            id: group.id || this.generateId(),
                            name: group.name || 'List',
                            buttons: group.buttons || [],
                        })
                    }
                }
            }
            if (migratedLists.length) {
                this.lists = migratedLists
                this.activeListId = pluginConfig.activeGroupId || this.lists[0].id
                this.saveLists()
                return
            }
        }

        // Single source of truth: the plugin config.
        if (pluginConfig.lists?.length) {
            this.lists = pluginConfig.lists
            this.activeListId = pluginConfig.activeListId || this.lists[0].id
            this.lastConfigSnapshot = this.configSnapshot()
            // Clean up the legacy duplicate storage file if it is still there.
            this.markLegacyStorageMigrated()
            return
        }

        // One-time migration from the old button-bar-lists.json file. New
        // versions never write this file again; it is only read if the config
        // has no lists yet, then renamed to *.migrated.
        const legacy = this.loadLegacyStorage()
        if (legacy?.lists?.length) {
            this.lists = legacy.lists
            this.activeListId = legacy.activeListId || this.lists[0].id
            this.saveLists()
            this.markLegacyStorageMigrated()
            return
        }

        // Default
        this.lists = [this.createDefaultList()]
        this.activeListId = this.lists[0].id
        this.saveLists()
    }

    private configSnapshot(): string {
        const buttonBarConfig = this.config.store.pluginConfig?.['button-bar']
        return JSON.stringify({
            lists: buttonBarConfig?.lists ?? [],
            activeListId: buttonBarConfig?.activeListId ?? '',
        })
    }

    private getStoragePath(): string | null {
        if (this.storagePath !== undefined) {
            return this.storagePath
        }
        const configPath = this.platformService.getConfigPath()
        if (!configPath) {
            this.storagePath = null
            return null
        }
        this.storagePath = path.join(path.dirname(configPath), 'button-bar-lists.json')
        return this.storagePath
    }

    private loadLegacyStorage(): ButtonBarStorage | null {
        const storagePath = this.getStoragePath()
        if (!storagePath) {
            return null
        }
        try {
            if (!existsSync(storagePath)) {
                return null
            }
            const content = readFileSync(storagePath, 'utf8')
            return JSON.parse(content) as ButtonBarStorage
        } catch (error) {
            console.warn('ButtonBar: Unable to read legacy storage file', error)
            return null
        }
    }

    private markLegacyStorageMigrated(): void {
        const storagePath = this.getStoragePath()
        if (!storagePath || !existsSync(storagePath)) {
            return
        }
        try {
            renameSync(storagePath, `${storagePath}.migrated`)
        } catch (error) {
            console.warn('ButtonBar: Unable to rename legacy storage file', error)
        }
    }

    saveLists(): void {
        // ConfigProxy exposes structural members as getter-only proxies, so
        // replace leaves instead of assigning the whole 'button-bar' object
        // (that throws a TypeError in strict mode and aborted saveButton()
        // before closeModal()).
        const buttonBarConfig = this.config.store.pluginConfig?.['button-bar']
        if (!buttonBarConfig) {
            console.warn('ButtonBar: pluginConfig["button-bar"] is missing')
            return
        }
        buttonBarConfig.lists = this.lists
        buttonBarConfig.activeListId = this.activeListId
        this.lastConfigSnapshot = this.configSnapshot()
        this.config.save()
    }

    private createDefaultList(): ButtonList {
        return {
            id: this.generateId(),
            name: 'List 1',
            buttons: [],
        }
    }

    private generateId(): string {
        return 'btn_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 7)
    }

    collapse(): void {
        this.collapsed = true
    }

    expand(): void {
        this.collapsed = false
    }

    private findTerminalTab(tab: BaseTabComponent | null): BaseTerminalTabComponent<any> | null {
        if (!tab) {
            return null
        }
        if (tab instanceof BaseTerminalTabComponent) {
            return tab
        }
        if (tab instanceof SplitTabComponent) {
            const focused = tab.getFocusedTab()
            const focusedTerminal = this.findTerminalTab(focused)
            if (focusedTerminal) {
                return focusedTerminal
            }

            for (const child of tab.getAllTabs()) {
                const candidate = this.findTerminalTab(child)
                if (candidate) {
                    return candidate
                }
            }
        }
        return null
    }

    private getFirstTerminalFromTabs(): BaseTerminalTabComponent<any> | null {
        const tabs = this.app.tabs || []
        for (const tab of tabs) {
            const candidate = this.findTerminalTab(tab)
            if (candidate) {
                return candidate
            }
        }
        return null
    }

    private getActiveTerminalTab(): BaseTerminalTabComponent<any> | null {
        const fromActive = this.findTerminalTab(this.app.activeTab)
        if (fromActive) {
            return fromActive
        }
        if (this.lastTerminalTab) {
            return this.lastTerminalTab
        }
        const fromTabs = this.getFirstTerminalFromTabs()
        if (fromTabs) {
            this.lastTerminalTab = fromTabs
            return fromTabs
        }
        return null
    }

    // Terminal command execution
    executeCommand(btn: ButtonCommand, event?: MouseEvent): void {
        event?.preventDefault()
        event?.stopPropagation()
        if (this.suppressClick) {
            this.suppressClick = false
            return
        }
        const terminal = this.getActiveTerminalTab()

        if (!terminal) {
            console.warn('ButtonBar: No terminal tab found')
            return
        }

        setTimeout(() => {
            void this.runCommandSteps(terminal, btn).catch(error => {
                console.error('ButtonBar: command execution failed', error)
            })
        }, 10)
    }

    /**
     * Execute a button command line by line. If a line has a wait
     * configuration, subscribe to the session output before sending that line
     * so fast output is not missed, then send the next line only after the
     * pattern matches (or abort on timeout).
     */
    private async runCommandSteps(terminal: BaseTerminalTabComponent<any>, btn: ButtonCommand): Promise<void> {
        terminal.frontend?.focus()
        const body = btn.command.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
        if (!body) {
            return
        }
        const lines = body.split('\n')
        const waits = btn.waits ?? []

        for (let i = 0; i < lines.length; i++) {
            const wait = i < lines.length - 1 ? waits[i] : null
            const waitPromise = wait?.pattern
                ? this.waitForOutput(terminal, wait.pattern, (wait.timeout ?? 30) * 1000)
                : null

            const isLast = i === lines.length - 1
            const enter = !isLast || btn.sendEnter === true
            terminal.sendInput(lines[i] + (enter ? '\r' : ''))

            if (waitPromise) {
                const matched = await waitPromise
                if (!matched) {
                    console.warn('ButtonBar: timed out waiting for "' + wait?.pattern + '"')
                    return
                }
            }
        }

        setTimeout(() => terminal.frontend?.focus(), 20)
    }

    private waitForOutput(terminal: BaseTerminalTabComponent<any>, pattern: string, timeoutMs: number): Promise<boolean> {
        return new Promise(resolve => {
            const session = terminal.session
            if (!session?.output$) {
                resolve(false)
                return
            }

            let buffer = ''
            let settled = false
            let subscription: Subscription | null = null
            let timer: ReturnType<typeof setTimeout> | null = null

            const finish = (matched: boolean): void => {
                if (settled) {
                    return
                }
                settled = true
                subscription?.unsubscribe()
                if (timer) {
                    clearTimeout(timer)
                }
                resolve(matched)
            }

            timer = setTimeout(() => finish(false), Math.max(timeoutMs, 500))
            subscription = session.output$.subscribe({
                next: data => {
                    buffer = (buffer + this.stripAnsi(data)).slice(-65536)
                    if (this.outputMatches(buffer, pattern)) {
                        finish(true)
                    }
                },
                error: () => finish(false),
                complete: () => finish(false),
            })
        })
    }

    private outputMatches(buffer: string, pattern: string): boolean {
        if (buffer.includes(pattern)) {
            return true
        }
        try {
            return new RegExp(pattern).test(buffer)
        } catch {
            return false
        }
    }

    private stripAnsi(text: string): string {
        return text
            .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
            .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
            .replace(/\x1b[@-Z\\-_]/g, '')
    }

    // Drag-to-reorder
    trackByButton(_index: number, btn: ButtonCommand): string {
        return btn.id
    }

    onButtonPointerDown(event: PointerEvent, btn: ButtonCommand): void {
        if (event.button !== 0) {
            return
        }
        this.cancelLongPress()
        this.pendingDragButton = btn
        this.draggingButton = null
        this.dragArmed = false
        this.dragMoved = false
        this.pointerStart = { x: event.clientX, y: event.clientY }
        this.longPressTimer = setTimeout(() => {
            this.longPressTimer = null
            if (this.pendingDragButton === btn) {
                this.dragArmed = true
            }
        }, 250)
    }

    @HostListener('document:pointermove', ['$event'])
    onDocumentPointerMove(event: PointerEvent): void {
        if (!this.dragArmed || !this.pendingDragButton) {
            return
        }
        const dx = event.clientX - this.pointerStart.x
        const dy = event.clientY - this.pointerStart.y
        if (!this.dragMoved && Math.hypot(dx, dy) < 6) {
            return
        }
        if (!this.dragMoved) {
            this.dragMoved = true
            this.draggingButton = this.pendingDragButton
            this.suppressClick = true
        }
        this.reorderButtonAtPoint(event.clientX, event.clientY)
    }

    @HostListener('document:pointerup')
    @HostListener('document:pointercancel')
    onDocumentPointerUp(): void {
        this.cancelLongPress()
        const wasDragging = this.draggingButton !== null
        this.draggingButton = null
        this.pendingDragButton = null
        this.dragArmed = false
        this.dragMoved = false
        if (wasDragging) {
            this.saveLists()
            // The click event (if any) is dispatched right after pointerup;
            // reset the flag afterwards so normal clicks keep working.
            setTimeout(() => {
                this.suppressClick = false
            }, 0)
        }
    }

    private cancelLongPress(): void {
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer)
            this.longPressTimer = null
        }
    }

    private reorderButtonAtPoint(x: number, y: number): void {
        const list = this.activeList
        const dragging = this.draggingButton
        if (!list || !dragging) {
            return
        }
        const element = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('button.cmd-btn') as HTMLElement | null
        const targetId = element?.dataset.btnId
        if (!targetId) {
            return
        }
        const from = list.buttons.indexOf(dragging)
        const to = list.buttons.findIndex(btn => btn.id === targetId)
        if (from === -1 || to === -1 || from === to) {
            return
        }
        const [moved] = list.buttons.splice(from, 1)
        list.buttons.splice(to, 0, moved)
    }

    // List menu
    toggleListMenu(event: MouseEvent): void {
        event.stopPropagation()
        this.listMenuVisible = !this.listMenuVisible
        if (this.listMenuVisible) {
            requestAnimationFrame(() => this.positionListMenu())
        }
    }

    closeListMenu(): void {
        this.listMenuVisible = false
        this.listMenuStyles = {}
    }

    private positionListMenu(): void {
        if (!this.listToggleButton || !this.listMenuElement) {
            return
        }

        const toggleRect = this.listToggleButton.nativeElement.getBoundingClientRect()
        const menuEl = this.listMenuElement.nativeElement
        const menuHeight = menuEl.offsetHeight
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight
        const margin = 8

        const availableAbove = toggleRect.top - margin
        const availableBelow = viewportHeight - toggleRect.bottom - margin
        const preferAbove = availableAbove >= menuHeight && availableAbove >= availableBelow

        const styles: Record<string, string> = {}

        if (preferAbove) {
            styles.bottom = `${toggleRect.height + margin}px`
            styles.top = 'auto'
            styles.maxHeight = `${Math.max(availableAbove, 120)}px`
        } else {
            styles.top = `${toggleRect.height + margin}px`
            styles.bottom = 'auto'
            styles.maxHeight = `${Math.max(availableBelow, 120)}px`
        }

        const menuWidth = menuEl.offsetWidth
        const overflowRight = toggleRect.left + menuWidth - window.innerWidth + 12
        styles.left = overflowRight > 0 ? `${Math.max(-overflowRight, -toggleRect.left)}px` : '0px'

        this.listMenuStyles = styles
    }

    @HostListener('window:resize')
    onWindowResize(): void {
        if (this.listMenuVisible) {
            this.positionListMenu()
        }
        if (this.contextMenuVisible) {
            this.positionContextMenu()
        }
    }

    // Move / Copy to list
    openMoveCopyModal(mode: 'move' | 'copy'): void {
        if (!this.contextMenuButton) {
            return
        }
        this.moveCopyMode = mode
        this.moveCopyButton = this.contextMenuButton
        this.moveCopySourceListId = this.activeListId
        this.moveCopyModalVisible = true
        this.closeContextMenu()
    }

    closeMoveCopyModal(): void {
        this.moveCopyModalVisible = false
        this.moveCopyButton = null
        this.moveCopySourceListId = ''
    }

    applyMoveCopy(target: ButtonList): void {
        const source = this.lists.find(list => list.id === this.moveCopySourceListId)
        const button = this.moveCopyButton
        if (!source || !button || target.id === source.id) {
            return
        }

        if (this.moveCopyMode === 'move') {
            const index = source.buttons.indexOf(button)
            if (index === -1) {
                return
            }
            source.buttons.splice(index, 1)
            target.buttons.push(button)
        } else {
            target.buttons.push({
                ...button,
                id: this.generateId(),
            })
        }

        try {
            this.saveLists()
        } catch (error) {
            console.error('ButtonBar: Unable to move/copy button', error)
        } finally {
            this.closeMoveCopyModal()
        }
    }

    // Edit Lists modal
    openEditLists(event?: MouseEvent): void {
        event?.preventDefault()
        event?.stopPropagation()
        this.closeListMenu()
        this.editListsVisible = true
    }

    closeEditLists(): void {
        this.clearEditDrag()
        this.editListsVisible = false
    }

    onEditButtonDragStart(list: ButtonList, btn: ButtonCommand, event: DragEvent): void {
        this.editDragButton = btn
        this.editDragSourceListId = list.id
        this.editDragOverListId = null
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'copyMove'
            event.dataTransfer.setData('text/plain', btn.id)
        }
    }

    onEditButtonDragEnd(): void {
        this.clearEditDrag()
    }

    onEditListDragOver(list: ButtonList, event: DragEvent): void {
        if (!this.editDragButton) {
            return
        }
        if (list.id === this.editDragSourceListId) {
            // Returning to the source list: hide a copy/move overlay that may
            // still be visible on the previous target.
            this.editDragOverListId = null
            return
        }
        event.preventDefault()
        this.editDragOverListId = list.id
        this.editDragRowId = null
    }

    onEditListDragLeave(list: ButtonList, event: DragEvent): void {
        if (this.editDragOverListId !== list.id) {
            return
        }
        const current = event.currentTarget as HTMLElement
        const related = event.relatedTarget as Node | null
        if (related && current.contains(related)) {
            return
        }
        this.editDragOverListId = null
    }

    isEditDropTarget(list: ButtonList): boolean {
        return this.editDragButton !== null
            && this.editDragSourceListId !== list.id
            && this.editDragOverListId === list.id
    }

    onEditRowDragOver(list: ButtonList, btn: ButtonCommand, event: DragEvent): void {
        if (!this.editDragButton || list.id !== this.editDragSourceListId) {
            return
        }
        this.editDragOverListId = null
        if (btn === this.editDragButton) {
            return
        }
        event.preventDefault()
        event.stopPropagation()
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
        this.editDragRowId = btn.id
        this.editDragRowPosition = event.clientY > rect.top + rect.height / 2 ? 'after' : 'before'
    }

    onEditRowDragLeave(list: ButtonList, btn: ButtonCommand, event?: DragEvent): void {
        if (this.editDragRowId !== btn.id) {
            return
        }
        const current = event?.currentTarget as HTMLElement | null
        const related = event?.relatedTarget as Node | null
        if (current && related && current.contains(related)) {
            return
        }
        this.editDragRowId = null
    }

    isEditRowDropTarget(list: ButtonList, btn: ButtonCommand, position: 'before' | 'after'): boolean {
        return this.editDragButton !== null
            && list.id === this.editDragSourceListId
            && this.editDragRowId === btn.id
            && this.editDragButton !== btn
            && this.editDragRowPosition === position
    }

    onEditRowDrop(list: ButtonList, targetBtn: ButtonCommand, event: DragEvent): void {
        event.preventDefault()
        event.stopPropagation()
        const dragging = this.editDragButton
        if (!dragging || list.id !== this.editDragSourceListId || dragging === targetBtn) {
            this.clearEditDrag()
            return
        }
        const from = list.buttons.indexOf(dragging)
        const targetIndex = list.buttons.indexOf(targetBtn)
        if (from === -1 || targetIndex === -1) {
            this.clearEditDrag()
            return
        }
        let insertIndex = targetIndex + (this.editDragRowPosition === 'after' ? 1 : 0)
        if (from < insertIndex) {
            insertIndex--
        }
        const [moved] = list.buttons.splice(from, 1)
        list.buttons.splice(insertIndex, 0, moved)
        try {
            this.saveLists()
        } catch (error) {
            console.error('ButtonBar: Unable to reorder button', error)
        } finally {
            this.clearEditDrag()
        }
    }

    dropEditButton(target: ButtonList, mode: 'move' | 'copy', event: DragEvent): void {
        event.preventDefault()
        event.stopPropagation()
        const button = this.editDragButton
        const source = this.lists.find(list => list.id === this.editDragSourceListId)
        if (!button || !source || target.id === source.id) {
            this.clearEditDrag()
            return
        }

        if (mode === 'move') {
            const index = source.buttons.indexOf(button)
            if (index === -1) {
                this.clearEditDrag()
                return
            }
            source.buttons.splice(index, 1)
            target.buttons.push(button)
        } else {
            target.buttons.push({
                ...button,
                id: this.generateId(),
            })
        }

        try {
            this.saveLists()
        } catch (error) {
            console.error('ButtonBar: Unable to apply edit-lists drop', error)
        } finally {
            this.clearEditDrag()
        }
    }

    private clearEditDrag(): void {
        this.editDragButton = null
        this.editDragSourceListId = ''
        this.editDragOverListId = null
        this.editDragRowId = null
    }

    // List operations
    setActiveList(id: string): void {
        if (this.activeListId === id) {
            this.closeListMenu()
            return
        }
        this.activeListId = id
        this.saveLists()
        this.closeListMenu()
    }

    createList(event?: MouseEvent): void {
        event?.stopPropagation()
        event?.preventDefault()
        this.closeListMenu()
        this.editingList = null
        this.listNameInput = `List ${this.lists.length + 1}`
        this.listNameModalVisible = true
    }

    renameList(event: MouseEvent, list: ButtonList): void {
        event.stopPropagation()
        event.preventDefault()
        this.closeListMenu()
        this.editingList = list
        this.listNameInput = list.name
        this.listNameModalVisible = true
    }

    duplicateList(event: MouseEvent, list: ButtonList): void {
        event.stopPropagation()
        event.preventDefault()
        this.closeListMenu()
        const copy: ButtonList = {
            id: this.generateId(),
            name: `${list.name} (copy)`,
            buttons: list.buttons.map(btn => ({ ...btn, id: this.generateId() })),
        }
        this.lists.push(copy)
        this.activeListId = copy.id
        this.saveLists()
    }

    deleteList(event: MouseEvent, list: ButtonList): void {
        event.stopPropagation()
        event.preventDefault()
        if (this.lists.length === 1) return
        this.closeListMenu()
        this.listToDelete = list
        this.deleteConfirmVisible = true
    }

    // List name modal methods
    closeListNameModal(): void {
        this.listNameModalVisible = false
        this.editingList = null
        this.listNameInput = ''
    }

    saveListName(): void {
        const name = this.listNameInput?.trim()
        if (!name) return

        if (this.editingList) {
            // Rename existing list
            this.editingList.name = name
        } else {
            // Create new list
            const list: ButtonList = {
                id: this.generateId(),
                name,
                buttons: [],
            }
            this.lists.push(list)
            this.activeListId = list.id
        }

        this.saveLists()
        this.closeListNameModal()
    }

    // Delete confirmation modal methods
    closeDeleteConfirm(): void {
        this.deleteConfirmVisible = false
        this.listToDelete = null
    }

    confirmDeleteList(): void {
        if (!this.listToDelete) return
        const listId = this.listToDelete.id
        this.lists = this.lists.filter(l => l.id !== listId)
        if (this.activeListId === listId) {
            this.activeListId = this.lists[0]?.id || ''
        }
        this.saveLists()
        this.closeDeleteConfirm()
    }

    // Command modal
    openAddModal(): void {
        this.editingButton = null
        this.modalData = {
            label: '',
            command: '',
            icon: '',
            color: this.presetColors[0],
            tooltip: '',
            sendEnter: false,
        }
        this.modalWaitRows = []
        this.modalVisible = true
    }

    openEditModal(btn: ButtonCommand): void {
        this.editingButton = btn
        this.modalData = { ...btn }
        this.modalWaitRows = this.buildWaitRows(btn)
        this.modalVisible = true
    }

    closeModal(): void {
        this.modalVisible = false
        this.editingButton = null
        this.modalData = {}
        this.modalWaitRows = []
    }

    onCommandInput(value: string): void {
        this.modalData.command = value ?? ''
        this.syncModalWaitRows()
    }

    private syncModalWaitRows(): void {
        const body = (this.modalData.command ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '')
        const needed = Math.max(body.split('\n').length - 1, 0)
        if (this.modalWaitRows.length > needed) {
            this.modalWaitRows = this.modalWaitRows.slice(0, needed)
        }
        while (this.modalWaitRows.length < needed) {
            this.modalWaitRows.push({ pattern: '', timeout: 30 })
        }
    }

    private buildWaitRows(btn: ButtonCommand): { pattern: string; timeout?: number }[] {
        const body = (btn.command ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '')
        const needed = Math.max(body.split('\n').length - 1, 0)
        const rows: { pattern: string; timeout?: number }[] = []
        for (let i = 0; i < needed; i++) {
            const wait = btn.waits?.[i]
            rows.push({
                pattern: wait?.pattern ?? '',
                timeout: wait?.timeout ?? 30,
            })
        }
        return rows
    }

    private buildWaitsForSave(): (ButtonWait | null)[] | undefined {
        const waits = this.modalWaitRows.map(wait => {
            const pattern = wait.pattern?.trim()
            if (!pattern) {
                return null
            }
            const timeout = Number(wait.timeout)
            return {
                pattern,
                timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
            }
        })
        return waits.some(wait => wait !== null) ? waits : undefined
    }

    saveButton(): void {
        if (!this.modalData.label || !this.modalData.command) return

        const list = this.activeList
        if (!list) return

        if (this.editingButton) {
            Object.assign(this.editingButton, {
                label: this.modalData.label,
                command: this.modalData.command?.replace(/\r\n?/g, '\n'),
                icon: this.modalData.icon || undefined,
                color: this.modalData.color || undefined,
                tooltip: this.modalData.tooltip || undefined,
                sendEnter: this.modalData.sendEnter,
                waits: this.buildWaitsForSave(),
            })
        } else {
            const commandText = this.modalData.command!.replace(/\r\n?/g, '\n')
            const newButton: ButtonCommand = {
                id: this.generateId(),
                label: this.modalData.label!,
                command: commandText,
                icon: this.modalData.icon || undefined,
                color: this.modalData.color || undefined,
                tooltip: this.modalData.tooltip || undefined,
                sendEnter: this.modalData.sendEnter,
                waits: this.buildWaitsForSave(),
            }
            list.buttons.push(newButton)
        }

        try {
            this.saveLists()
        } catch (error) {
            console.error('ButtonBar: Unable to save lists', error)
        } finally {
            this.closeModal()
        }
    }

    // Context menu
    onButtonContextMenu(event: MouseEvent, btn: ButtonCommand): void {
        event.preventDefault()
        event.stopPropagation()

        const target = event.currentTarget as HTMLElement | null
        this.contextMenuButton = btn
        this.contextMenuAnchor = target?.getBoundingClientRect() ?? null

        // Render hidden first, then measure the real menu size before placing it.
        this.contextMenuStyles = { left: '0px', top: '0px', visibility: 'hidden' }
        this.contextMenuVisible = true
        requestAnimationFrame(() => this.positionContextMenu())
    }

    /**
     * Place the context menu inside the viewport:
     * prefer above the button (the bar sits at the bottom), flip below if needed,
     * clamp both axes to an 8px margin, and let it scroll internally when it is
     * taller than the viewport.
     */
    private positionContextMenu(): void {
        const el = this.contextMenuElement?.nativeElement
        const anchor = this.contextMenuAnchor
        if (!el || !anchor) {
            return
        }

        const margin = 8
        const gap = 6
        const vw = window.innerWidth || document.documentElement.clientWidth
        const vh = window.innerHeight || document.documentElement.clientHeight

        // Measure the natural size (clear constraints from a previous opening).
        el.style.maxHeight = ''
        el.style.maxWidth = ''
        el.style.minWidth = ''
        el.style.overflowY = ''
        const natural = el.getBoundingClientRect()
        let width = natural.width
        let height = natural.height

        let top = anchor.top - gap - height
        if (top < margin) {
            if (anchor.bottom + gap + height <= vh - margin) {
                top = anchor.bottom + gap
            } else {
                height = Math.max(vh - margin * 2, 0)
                el.style.maxHeight = `${height}px`
                el.style.overflowY = 'auto'
                top = margin
            }
        }
        top = Math.min(Math.max(top, margin), Math.max(margin, vh - margin - height))

        if (width > vw - margin * 2) {
            width = Math.max(vw - margin * 2, 0)
            el.style.minWidth = '0'
            el.style.maxWidth = `${width}px`
            el.style.overflowX = 'auto'
        }
        let left = anchor.left
        if (left + width > vw - margin) {
            left = anchor.right - width
        }
        left = Math.min(Math.max(left, margin), Math.max(margin, vw - margin - width))

        this.contextMenuStyles = {
            left: `${Math.round(left)}px`,
            top: `${Math.round(top)}px`,
            visibility: 'visible',
        }
    }

    contextMenuEdit(): void {
        if (this.contextMenuButton) {
            this.openEditModal(this.contextMenuButton)
        }
        this.closeContextMenu()
    }

    contextMenuDuplicate(): void {
        if (this.contextMenuButton && this.activeList) {
            const newButton: ButtonCommand = {
                ...this.contextMenuButton,
                id: this.generateId(),
                label: this.contextMenuButton.label + ' (copy)',
            }
            this.activeList.buttons.push(newButton)
            this.saveLists()
        }
        this.closeContextMenu()
    }

    contextMenuDelete(): void {
        if (this.contextMenuButton && this.activeList) {
            const index = this.activeList.buttons.indexOf(this.contextMenuButton)
            if (index !== -1) {
                this.activeList.buttons.splice(index, 1)
                this.saveLists()
            }
        }
        this.closeContextMenu()
    }

    // Import/Export
    openImportExportModal(event?: MouseEvent): void {
        event?.stopPropagation()
        event?.preventDefault()
        this.listsJson = JSON.stringify({ lists: this.lists, activeListId: this.activeListId }, null, 2)
        this.importExportModalVisible = true
        this.closeListMenu()
    }

    closeImportExportModal(): void {
        this.importExportModalVisible = false
    }

    exportLists(): void {
        this.listsJson = JSON.stringify({ lists: this.lists, activeListId: this.activeListId }, null, 2)
    }

    importLists(): void {
        if (!this.listsJson) return
        try {
            const parsed = JSON.parse(this.listsJson)
            const rawLists = Array.isArray(parsed) ? parsed : parsed.lists
            if (!Array.isArray(rawLists) || !rawLists.length) {
                throw new Error('No lists found')
            }
            this.lists = rawLists.map((list: any) => ({
                id: list.id || this.generateId(),
                name: list.name || 'List',
                buttons: (list.buttons || []).map((btn: any) => ({
                    ...btn,
                    id: btn.id || this.generateId(),
                })),
            }))
            const candidateId = typeof parsed.activeListId === 'string' ? parsed.activeListId : ''
            if (candidateId && this.lists.some(l => l.id === candidateId)) {
                this.activeListId = candidateId
            } else {
                this.activeListId = this.lists[0].id
            }
            this.saveLists()
            this.closeImportExportModal()
        } catch (err) {
            console.warn('ButtonBarComponent: Unable to parse lists JSON', err)
        }
    }
}
