import sqlite3
import os
import re  # For Regex
import joblib  # For loading your trained model
from datetime import datetime, timedelta
from typing import TypedDict, Optional
from langgraph.graph import StateGraph, END
from dotenv import load_dotenv  

# Email & SSL Imports 
import smtplib
import ssl
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.application import MIMEApplication
from datetime import datetime, timedelta

from pdf2image import convert_from_path
from PIL import Image
import pytesseract

load_dotenv()

# --- Tesseract OCR Configuration ---
try:
    import pytesseract
    from PIL import Image
    TESSERACT_ENABLED = True
    # --- !! IMPORTANT !! ---
    # Update this path to where Tesseract is installed on your system.
    TESSERACT_CMD_PATH = os.getenv('TESSERACT_PATH') or r'C:\Program Files\Tesseract-OCR\tesseract.exe'
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD_PATH
except (ImportError, FileNotFoundError):
    print("[Warning] Pytesseract or Pillow not found, or Tesseract executable path is wrong. OCR will be simulated.")
    TESSERACT_ENABLED = False


# --- 1. CRITICAL: Database Pathing Logic ---

def get_db_path():
    """
    Robustly finds the path to 'epics.db'.
    It assumes 'mas_workflow.py' is in 'mas_engine' and 'epics.db' 
    is in the parent directory alongside server.js.
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    parent_dir = os.path.dirname(script_dir)
    db_path = os.path.join(parent_dir, 'epics.db')
    return db_path

DB_PATH = get_db_path()
print(f"*** Monitoring DB Path: {DB_PATH} ***")

# --- NEW/MODIFIED: Model Loading & Email Configuration ---

# Load the trained Naive Bayes model
try:
    script_dir = os.path.dirname(os.path.abspath(__file__))
    model_path = os.path.join(script_dir, 'letter_classifier.joblib')
    CLASSIFIER_MODEL = joblib.load(model_path)
    print(f"*** Naive Bayes Classifier loaded from {model_path} ***")
except FileNotFoundError:
    print("[FATAL ERROR] 'letter_classifier.joblib' not found.")
    print("Please run 'train_model.py' first.")
    CLASSIFIER_MODEL = None

# --- !! IMPORTANT: Fill in your Email Details !! ---
# This is required for Aim 6 (Email Notifications)
SMTP_SERVER = os.getenv('SMTP_SERVER') 
SMTP_PORT = int(os.getenv('SMTP_PORT')) 
# VVVVVVVV SENDER CONFIGURATION: SET TO YOUR TEST EMAIL VVVVVVVV
SENDER_EMAIL = os.getenv('SENDER_EMAIL') 
SENDER_PASSWORD = os.getenv('SENDER_PASSWORD')
# ^^^^^^^^ SENDER CONFIGURATION ^^^^^^^^
# --- END NEW/MODIFIED ---


def get_db_connection():
    """Connects to the SQLite database using the robust path."""
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"Database not found at {DB_PATH}. Please run 'node server.js' first to create it.")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def update_letter_state(letter_id, **kwargs):
    """Dynamically updates fields for a given letter ID."""
    if not kwargs:
        return
    conn = get_db_connection()
    cursor = conn.cursor()
    set_clauses = [f"{key} = ?" for key in kwargs.keys()]
    set_values = list(kwargs.values())
    set_values.append(letter_id)
    query = f"UPDATE letters SET {', '.join(set_clauses)} WHERE id = ?"
    try:
        cursor.execute(query, set_values)
        conn.commit()
    except sqlite3.Error as e:
        print(f"   [DB ERROR] Failed to update letter {letter_id}: {e}")
    finally:
        conn.close()


def get_letter_by_id(letter_id):
    """Fetches a single letter record."""
    conn = get_db_connection()
    letter = conn.cursor().execute("SELECT * FROM letters WHERE id = ?", (letter_id,)).fetchone()
    conn.close()
    return dict(letter) if letter else None

def get_pending_events():
    """Fetches letters that need Agent attention."""
    conn = get_db_connection()
    current_time = datetime.now().isoformat()
    query = f"""
    SELECT * FROM letters 
    WHERE status IN ('ML_OCR', 'Submitted', 'ActionTaken') 
    OR (status = 'Pending' AND approvalDeadline IS NOT NULL AND approvalDeadline < '{current_time}')
    ORDER BY date DESC
    """
    letters = conn.cursor().execute(query).fetchall()
    conn.close()
    return [dict(l) for l in letters]

# --- 2. Perplexity API Integration (LCA) ---
#    (This section was correctly removed in your provided file)

# --- 3. LangGraph State Definition ---

class WorkflowState(TypedDict):
    letter_id: str
    notification_needed: Optional[bool]
    notification_target_email: Optional[str]
    notification_message: Optional[str]


# --- 4. Agent Functions (Nodes) ---
def _get_full_text(file_path_relative: str) -> str:
    """
    Helper function to extract text from either PDF or image files using Tesseract OCR.
    Supports both image formats (PNG, JPG, JPEG) and PDF files.
    Includes safety for missing Poppler and missing Tesseract path.
    """
    import os
    from PIL import Image
    import pytesseract
    from pdf2image import convert_from_path

    # ✅ Ensure Tesseract path is set correctly
    pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

    # ✅ Check that OCR is enabled and file path is valid
    if not TESSERACT_ENABLED or not file_path_relative:
        return ""

    script_dir = os.path.dirname(os.path.abspath(__file__))
    parent_dir = os.path.dirname(script_dir)
    file_path_absolute = os.path.join(parent_dir, file_path_relative)

    if not os.path.exists(file_path_absolute):
        print(f"   [OCR_HELPER_ERROR] File not found: {file_path_absolute}")
        return ""

    text = ""
    ext = os.path.splitext(file_path_absolute)[1].lower()

    try:
        # --- Handle PDFs ---
        if ext == ".pdf":
            print("   [OCR_HELPER] Converting PDF to images for OCR...")
            try:
                # ✅ If Poppler is installed, specify its path here
                poppler_path = r"C:\Program Files\poppler-25.07.0\Library\bin"
                pages = convert_from_path(file_path_absolute, dpi=300, poppler_path=poppler_path)
            except Exception as e:
                print(f"   [OCR_HELPER_WARNING] Poppler not found or failed: {e}")
                print("   [OCR_HELPER] Skipping PDF OCR (install Poppler to enable).")
                return ""

            for i, page in enumerate(pages):
                page_text = pytesseract.image_to_string(page, lang="eng", config="--psm 6")
                text += f"\n--- PAGE {i+1} ---\n{page_text}"

        # --- Handle images directly ---
        elif ext in [".png", ".jpg", ".jpeg", ".tif", ".bmp"]:
            print("   [OCR_HELPER] Running OCR on image file...")
            img = Image.open(file_path_absolute)
            text = pytesseract.image_to_string(img, lang="eng", config="--psm 6")

        else:
            print(f"   [OCR_HELPER_WARNING] Unsupported file format: {ext}")
            return ""

    except Exception as e:
        print(f"   [OCR_HELPER_ERROR] Could not run Tesseract: {e}")
        return ""

    print(f"   [OCR_HELPER] Extracted {len(text)} characters of text.")
    return text.strip()

import re

def extract_subject_from_text(raw_text: str) -> str:
    """
    Extracts subject line(s) robustly from OCR text.
    Handles multi-line subjects and tolerates OCR noise.
    """
    lines = [line.strip() for line in raw_text.splitlines() if line.strip()]
    subject_text = ""

    for i, line in enumerate(lines):
        # Match variations like "Subject", "Sub:", "Re:", "Regarding"
        if re.search(r'\b(subject|sub|regarding|re)\b', line, re.IGNORECASE):
            # Clean OCR noise
            line = re.sub(r'[^a-zA-Z0-9 ,.:;\'"@()\-\n]', ' ', line)
            # Remove the keyword itself (e.g. "Subject: ", "Re - ")
            line = re.sub(r'(?i)\b(subject|sub|regarding|re)\b\s*[:\-–]?\s*', '', line).strip()

            subject_text = line

            # ✅ Capture continuation lines (if next lines look like continuation)
            for j in range(i + 1, min(i + 3, len(lines))):  # look ahead 2 lines max
                next_line = lines[j].strip()
                # Stop if next line looks like a header
                if re.search(r'(dear|sir|madam|to:|from:|date)', next_line, re.IGNORECASE):
                    break
                if len(next_line.split()) > 2:
                    subject_text += " " + next_line
            break

    # --- Fallback: use first meaningful long line ---
    if not subject_text:
        for line in lines:
            if len(line.split()) > 5 and not re.search(r'(dear|sir|madam|to:|from:|date)', line, re.IGNORECASE):
                subject_text = line.strip()
                break

    subject_text = re.sub(r'\s+', ' ', subject_text).strip()
    subject_text = subject_text.title()
    acronyms = ["VC", "AI", "IoT", "HR", "PhD", "MBA", "UGC", "UG", "PG"]
    for ac in acronyms:
        subject_text = re.sub(rf'\b{ac.title()}\b', ac, subject_text)

    return subject_text if subject_text else "Subject not found"


def letter_classifying_agent(state: WorkflowState):
    """
    STEP 3 (LCA): Runs Tesseract/Local ML to autofill the clerk's form.
    (This is your existing code, which is correct.)
    """
    letter_id = state['letter_id']
    letter = get_letter_by_id(letter_id)
    file_path_relative = letter.get('filePath')

    print(f"[LCA] Processing file for ID {letter_id}...")

    raw_text = _get_full_text(file_path_relative)
    print(f"   [LCA DEBUG] OCR extracted {len(raw_text)} characters:\n{raw_text[:400]}\n---")


    if not raw_text:
        print(f"   [LCA] Tesseract extracted no text or file was not found.")
        raw_text = "No text extracted." # Set a default to prevent crash
        
    if not CLASSIFIER_MODEL:
        print(f"   [LCA] Fallback triggered. Status set to ERROR.")
        update_letter_state(letter_id, status='ERROR', remarks='LCA Agent failed. Model not loaded.')
        return state

    # --- LOCAL PREDICTION LOGIC ---
    try:
        # 1. Classify Type using Naive Bayes
        predicted_type = CLASSIFIER_MODEL.predict([raw_text])[0]

        # 2. Extract Subject using Regex
        predicted_subject = extract_subject_from_text(raw_text)

        # 3. Extract Amount using Regex
        predicted_amount = 0
        if predicted_type == "Payment":
            amount_match = re.search(r"(?:Amount|Rs\.?|INR)\s*:?\s*([\d,]+)", raw_text, re.IGNORECASE)
            if amount_match:
                predicted_amount = int(amount_match.group(1).replace(',', ''))

        print(f"   [LCA] Model Drafted data. Type: {predicted_type}, Subject: {predicted_subject}, Amount: {predicted_amount}")

        update_letter_state(letter_id,
            subject=predicted_subject,
            type=predicted_type,
            amount=predicted_amount,
            classification=predicted_type,
            status='ML_DRAFTED',
            remarks='Auto-drafted by local ML model. Needs Clerk review.'
        )

    except Exception as e:
        print(f"   [LCA ERROR] Local prediction failed: {e}")
        update_letter_state(letter_id, status='ERROR', remarks=f'LCA Agent failed during local ML processing: {e}')
    # --- END LOCAL PREDICTION LOGIC ---

    return state


# --- NEW/MODIFIED: Smarter Priority Prediction Agent (Aim 4) ---
def priority_prediction_agent(state: WorkflowState):
    """
    STEP 4 (PPA): Predicts priority based on body content and metadata.
    """
    letter_id = state['letter_id']
    letter = get_letter_by_id(letter_id)
    print(f"[PPA] Predicting priority for letter {letter_id}...")

    # 1. Get full text content
    raw_text = _get_full_text(letter.get('filePath')).lower()
    
    # 2. Define priority keywords
    PRIORITY_KEYWORDS = {
        "medical": 30,
        "emergency": 30,
        "urgent": 20,
        "immediate": 20,
        "scholarship": 15,
        "financial aid": 15,
        "deadline": 10
    }
    
    # 3. Score based on content
    score = 40  # Base score for all letters
    
    for keyword, points in PRIORITY_KEYWORDS.items():
        if keyword in raw_text:
            score += points
            
    # 4. Score based on metadata (from clerk)
    if letter.get('classification') == 'Payment' and letter.get('amount', 0) > 50000:
        score += 25
    if "urgent" in letter.get('subject', '').lower():
        score += 15
        
    # Cap the score at 100
    score = min(100, score)
        
    estimated_days = (100 - score) // 15 + 2 # Simple estimation logic

    update_letter_state(letter_id,
        priorityScore=score,
        estimatedTime=f"{estimated_days} days",
        status='Prioritized'
    )
    print(f"   [PPA] Priority Score: {score} (based on content). Status set to Prioritized.")
    return state
# --- END NEW/MODIFIED ---



def router_agent(state: WorkflowState):
    """
    STEP 5 & 6 (Router): Orchestrates workflow, sets next stage, and handles deadlines.
    MODIFIED: All outbound emails are temporarily routed to the test address.
    """
    letter_id = state['letter_id']
    letter = get_letter_by_id(letter_id)
    
    if not letter:
        return state

    current_status = letter['status']
    current_stage = letter['stage']
    classification = letter.get('classification')
    
    print(f"[Router] Routing Letter {letter_id} (Status: {current_status}, Stage: {current_stage})")
    
    state['notification_needed'] = False
    
    # VVVVVVVV TEMPORARY RECEIVER OVERRIDE FOR TESTING VVVVVVVV
    TEST_RECEIVER_EMAIL = 'monika032024@gmail.com'
    # ^^^^^^^^ TEMPORARY RECEIVER OVERRIDE FOR TESTING ^^^^^^^^


    if current_status == 'Prioritized':
        next_stage = 'Dean'
        deadline = (datetime.now() + timedelta(days=2)).isoformat()
        update_letter_state(letter_id, stage=next_stage, status='Pending', remarks=f"Pending approval at {next_stage}", approvalDeadline=deadline)
        state.update({
            'notification_needed': False,
            # ORIGINAL: 'notification_target_email': f"{next_stage.lower()}@siddhartha.com",
            'notification_target_email': TEST_RECEIVER_EMAIL, # Rerouted for testing
            'notification_message': f"New Task: Letter {letter_id} requires your approval."
        })

    elif current_status == 'ActionTaken':
        pipeline = PAYMENT_PIPELINE if classification == 'Payment' else PERMISSION_PIPELINE
        
        # Check for rejection remarks. This assumes "reject" is in the remarks.
        is_rejection = "reject" in (letter.get(f"{current_stage.lower()}Remarks", "") or "").lower()

        if is_rejection:
            update_letter_state(letter_id, stage='Clerk', status='Rejected', remarks=f"Rejected by {current_stage}", approvalDeadline=None)
            state.update({
                'notification_needed': True,
                # ORIGINAL: 'notification_target_email': f"clerk@{letter['dept'].lower()}.com",
                'notification_target_email': TEST_RECEIVER_EMAIL, # Rerouted for testing
                'notification_message': f"Update: Letter {letter_id} was rejected by {current_stage}."
            })
        else: # Forward
            try:
                current_index = pipeline.index(current_stage)
                if current_index < len(pipeline) - 1:
                    next_stage = pipeline[current_index + 1]
                    deadline = (datetime.now() + timedelta(days=2)).isoformat()
                    update_letter_state(letter_id, stage=next_stage, status='Pending', remarks=f"Forwarded. Pending at {next_stage}", approvalDeadline=deadline)
                    state.update({
                        'notification_needed': False,
                        # ORIGINAL: 'notification_target_email': f"{next_stage.lower()}@siddhartha.com",
                        # 'notification_target_email': TEST_RECEIVER_EMAIL, # Rerouted for testing
                        # 'notification_message': f"New Task: Letter {letter_id} requires your approval."
                    })
                else: # End of pipeline
                    update_letter_state(letter_id, status='Approved', remarks='Final approval reached.', approvalDeadline=None)
                    state.update({'notification_needed': True, 'notification_message': f"Success: Letter {letter_id} is fully approved."})
            except ValueError:
                print(f"  [Router ERROR] Stage '{current_stage}' not found in pipeline for classification '{classification}'.")
                update_letter_state(letter_id, status='ERROR', remarks=f"Invalid stage '{current_stage}' for this letter type.")

    elif current_status == 'Pending': # This condition is met for overdue letters
        update_letter_state(letter_id, status='Overdue', remarks=f'Deadline breached at {current_stage}!')
        state.update({
            'notification_needed': False,
            # ORIGINAL: 'notification_target_email': f"{current_stage.lower()}@siddhartha.com",
            'notification_target_email': TEST_RECEIVER_EMAIL, # Rerouted for testing
            'notification_message': f"URGENT: Letter {letter_id} at {current_stage} is overdue!"
        })
    return state


# --- NEW/MODIFIED: Real Email Notification Agent (Aim 6) ---
def email_notification_agent(state: WorkflowState):
    """
    STEP 6 (Email Agent): Sends context-aware emails when triggered by the Router Agent.
    - If status is 'Pending' -> sends task assignment email.
    - If status is 'Overdue' -> sends reminder email.
    """
    if not state.get('notification_needed'):
        return state

    letter_id = state.get('letter_id')
    letter = get_letter_by_id(letter_id)
    if not letter:
        print(f"[Email Agent] Letter {letter_id} not found.")
        return state

    # --- Extract routing info from state ---
    to_email = state.get('notification_target_email', 'admin@siddhartha.com')
    message_type = state.get('notification_message', 'Notification from MAS System')
    stage = letter.get('stage', 'Unknown')
    status = letter.get('status', 'Unknown')

    # --- Compose Email ---
    if status == "Overdue":
        subject = f"⚠️ Reminder: Letter {letter_id} is Overdue for Approval"
        greeting = f"Dear {stage},"
        body = f"""
{greeting}

This is a reminder that the following letter has been pending your approval for more than 2 days.

Letter Details:
  • Letter ID: {letter_id}
  • Subject: {letter.get('subject', 'N/A')}
  • Department: {letter.get('dept', 'N/A')}
  • Classification: {letter.get('classification', 'N/A')}
  • Current Status: {letter.get('status', 'N/A')}
  • Submission Date: {letter.get('date', 'N/A')}

Kindly review and approve the letter at your earliest convenience to ensure smooth workflow processing.

Thank you for your attention.

Warm regards,
MAS Automated Workflow System
(Siddhartha University)
"""
    else:
        subject = f"📄 New Letter Assigned for Your Review (ID: {letter_id})"
        greeting = f"Dear {stage},"
        body = f"""
{greeting}

A new letter has been routed to you for review and approval.

Letter Details:
  • Letter ID: {letter_id}
  • Subject: {letter.get('subject', 'N/A')}
  • Department: {letter.get('dept', 'N/A')}
  • Classification: {letter.get('classification', 'N/A')}
  • Current Status: {letter.get('status', 'N/A')}
  • Submission Date: {letter.get('date', 'N/A')}

Please log in to the MAS Dashboard to review and take action on this letter.

Thank you for your prompt attention.

Warm regards,
MAS Automated Workflow System
(Siddhartha University)
"""

    msg = MIMEMultipart()
    msg['Subject'] = subject
    msg['From'] = SENDER_EMAIL
    msg['To'] = to_email
    msg.attach(MIMEText(body, "plain"))

    # --- Attach original letter (PDF/Image) if available ---
    file_path = letter.get('filePath')
    if file_path:
        abs_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), file_path)
        if os.path.exists(abs_path):
            try:
                with open(abs_path, "rb") as f:
                    part = MIMEApplication(f.read(), Name=os.path.basename(abs_path))
                    part['Content-Disposition'] = f'attachment; filename="{os.path.basename(abs_path)}"'
                    msg.attach(part)
            except Exception as e:
                print(f"   [Email Agent WARNING] Could not attach file: {e}")

    # --- Send email ---
    if SENDER_EMAIL == "your-email@gmail.com":
        print(f"[Email Agent] SKIPPING EMAIL (configure SENDER_EMAIL and SENDER_PASSWORD).")
        print(f"   Would have sent to: {to_email} | Subject: {subject}")
        return state

    print(f"[Email Agent] Sending email to {to_email} ({stage}) about Letter {letter_id}...")

    try:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT, context=context) as server:
            server.login(SENDER_EMAIL, SENDER_PASSWORD)
            server.sendmail(SENDER_EMAIL, [to_email], msg.as_string())
            print(f"   [Email Agent] Email sent successfully to {to_email}.")
    except Exception as e:
        print(f"   [Email Agent ERROR] Failed to send email: {e}")

    return state

# --- END NEW/MODIFIED ---

def analysis_agent(state: WorkflowState):
    """
    STEP 7 (Analysis): Runs periodic ADMIN-ONLY analysis in the terminal.
    """
    conn = get_db_connection()
    bottlenecks = conn.cursor().execute("SELECT stage, COUNT(*) FROM letters WHERE status IN ('Pending', 'Overdue') GROUP BY stage").fetchall()
    status_summary = conn.cursor().execute("SELECT status, COUNT(*) FROM letters GROUP BY status").fetchall()
    conn.close()

    print("\n--- Admin System Health Check ---")
    print(f"  [Analysis] Pending/Overdue by Stage (Bottlenecks): {dict(bottlenecks)}")
    print(f"  [Analysis] Status Totals: {dict(status_summary)}")
    print("-----------------------------------")
    return state

PAYMENT_PIPELINE = ['Dean', 'Registrar', 'VC', 'Accounts']
PERMISSION_PIPELINE = ['Dean', 'Registrar', 'VC']


def initial_dispatcher(state: WorkflowState):
    """Decides the first agent to run and stores it in state['next']"""
    letter = get_letter_by_id(state['letter_id'])
    if not letter:
        print(f"  [Dispatcher] Letter {state['letter_id']} not found. Ending workflow.")
        state["next"] = "end"
        return state

    status = letter["status"]
    print(f"  [Dispatcher] Letter {state['letter_id']} has status: {status}. Routing accordingly.")

    if status == "ML_OCR":
        state["next"] = "lca"
    elif status == "Submitted":
        state["next"] = "ppa"
    else:
        state["next"] = "router"
    return state



def create_mas_graph():
    workflow = StateGraph(WorkflowState)

    workflow.add_node("initial_dispatcher", initial_dispatcher)
    workflow.add_node("lca", letter_classifying_agent)
    workflow.add_node("ppa", priority_prediction_agent)
    workflow.add_node("router", router_agent)
    workflow.add_node("email_notifier", email_notification_agent)

    workflow.set_entry_point("initial_dispatcher")

    workflow.add_conditional_edges(
        "initial_dispatcher",
        lambda s: s["next"],
        {"lca": "lca", "ppa": "ppa", "router": "router", "end": END},
    )

    workflow.add_edge("lca", END)
    workflow.add_edge("ppa", "router")
    workflow.add_edge("router", "email_notifier")
    workflow.add_edge("email_notifier", END)

    return workflow.compile()

# --- 6. Execution Loop ---

if __name__ == "__main__":
    print("--- Starting MAS Workflow Engine ---")
    
    app = create_mas_graph()
        
    # VVVVVVVV REMOVED TEMPORARY TEST BLOCK VVVVVVVV
    # The temporary test block is removed to let the main loop run.
    # The router_agent will now force all emails to be sent to xyz@gmail.com
    # ^^^^^^^^ REMOVED TEMPORARY TEST BLOCK ^^^^^^^^

    while True:
        try:
            pending_events = get_pending_events()
            
            if not pending_events:
                # --- MODIFIED: Run the admin health check when idle ---
                analysis_agent({}) 
                print("[MAS] No new events found. Sleeping...")
                import time
                time.sleep(3)
                continue

            print(f"\n[MAS] Found {len(pending_events)} event(s) to process.")
            
            for event in pending_events:
                print(f"\n[MAS] PROCESSING LETTER {event['id']} (Status: {event['status']})")
                
                initial_state = {'letter_id': event['id']}
                
                app.invoke(initial_state)

        except KeyboardInterrupt:
            print("\n--- Shutting down MAS Workflow Engine ---")
            break
        except Exception as e:
            print(f"\n[MAS] FATAL ERROR IN AGENT LOOP: {e}")
            import time
            time.sleep(20)
