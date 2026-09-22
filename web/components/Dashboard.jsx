"use client";
import { useEffect, useRef, useState } from "react";
import { models as sampleModels, providers as sampleProviders, initialWorkspace, storageKey, routeCall, validWorkspace, money } from "../lib/demo";
import { API_BASE, ApiError, api, clearKey, downloadJSON, getMode, loadKey, loadWorkspace, saveKey, setMode, streamChat, toCatalogModel, toProvider, toReceiptRow, validKey } from "../lib/api";
import { connect, ensureChain, hasWallet, personalSign, sendTransactions, shortAddress } from "../lib/wallet";
import { Button, Modal, Code, CopyButton } from "./UI";
import ModelCatalog from "./ModelCatalog";

const tabs = ["Overview", "Playground", "Models", "API keys", "Receipts", "Payments", "Providers", "Settings"];
const tabId = (t) => t.toLowerCase().replace(" ", "-");
const publicTabs = ["Models", "Providers"];
