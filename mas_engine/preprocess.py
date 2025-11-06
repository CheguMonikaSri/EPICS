import os
import csv
import pathlib
import pandas as pd # Added pandas to easily read the labels CSV
try:
    import pytesseract
    from PIL import Image
except ImportError:
    print("Error: Pytesseract or Pillow not found.")
    print("Please run: pip install pillow pytesseract pandas") # Added pandas here
    exit()

# --- Configuration ---
TESSERACT_CMD_PATH = os.getenv('TESSERACT_PATH') or r'C:\Program Files\Tesseract-OCR\tesseract.exe'
try:
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD_PATH
except FileNotFoundError:
    print(f"Error: Tesseract executable not found at {TESSERACT_CMD_PATH}")
    print("Please install Tesseract and/or update the TESSERACT_CMD_PATH variable.")
    exit()

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LETTERS_DIR = os.path.join(SCRIPT_DIR, 'training_letters')
LABELS_CSV_PATH = os.path.join(SCRIPT_DIR, 'labels.csv') # Path to your new labels file
DATASET_CSV_PATH = os.path.join(SCRIPT_DIR, 'dataset.csv') # Output dataset path
# ---------------------

def extract_text(file_path):
    """Uses Tesseract to extract text from an image file."""
    try:
        return pytesseract.image_to_string(Image.open(file_path))
    except Exception as e:
        print(f"  Could not process file {file_path}: {e}")
        return None

def load_labels(csv_path):
    """Loads the filename-to-label mapping from labels.csv."""
    try:
        labels_df = pd.read_csv(csv_path)
        # Convert to a dictionary for quick lookup: { "filename.png": "Payment", ... }
        label_map = pd.Series(labels_df.label.values, index=labels_df.filename).to_dict()
        print(f"Loaded {len(label_map)} labels from {csv_path}")
        return label_map
    except FileNotFoundError:
        print(f"Error: Label mapping file '{csv_path}' not found.")
        print("Please create labels.csv with 'filename,label' columns.")
        return None
    except Exception as e:
        print(f"Error reading {csv_path}: {e}")
        return None

def main():
    print("--- Starting Letter Preprocessing (Automated) ---")
    
    # --- 1. Load Labels ---
    label_map = load_labels(LABELS_CSV_PATH)
    if label_map is None:
        return # Stop if labels couldn't be loaded

    # --- 2. Find Image Files ---
    print(f"Looking for letter images in: {LETTERS_DIR}")
    letter_files = list(pathlib.Path(LETTERS_DIR).glob('*.*[png|jpg|jpeg|bmp|tif]'))
    
    if not letter_files:
        print("Error: No image files found in 'training_letters' folder.")
        return

    print(f"Found {len(letter_files)} image files.")
    processed_data = []
    skipped_count = 0
    label_not_found_count = 0

    # --- 3. Process Each Image ---
    for file_path in letter_files:
        filename = file_path.name
        print(f"\nProcessing: {filename}")
        
        # Check if we have a label for this file
        if filename not in label_map:
            print(f"  Warning: No label found for '{filename}' in labels.csv. Skipping.")
            label_not_found_count += 1
            continue
            
        # Get the label from the map
        label = label_map[filename]
        if label not in ["Payment", "Permission"]:
             print(f"  Warning: Invalid label '{label}' for '{filename}' in labels.csv. Skipping.")
             skipped_count += 1
             continue
             
        # Extract text using Tesseract
        raw_text = extract_text(file_path)
        if raw_text is None or not raw_text.strip():
            print(f"  Warning: No text extracted from '{filename}'. Skipping.")
            skipped_count += 1
            continue
            
        # Add the extracted text and label to our results
        processed_data.append([raw_text, label])
        print(f"  -> Extracted text and applied label: {label}")

    # --- 4. Save to Output Dataset CSV ---
    if not processed_data:
        print("\nNo data was successfully processed. 'dataset.csv' will not be created.")
        return

    print("\n" + "="*50)
    print(f"Processing complete.")
    if label_not_found_count > 0:
         print(f"Warning: {label_not_found_count} file(s) skipped because they were not listed in labels.csv.")
    if skipped_count > 0:
        print(f"Warning: {skipped_count} file(s) skipped due to errors (OCR failure or invalid label).")
        
    print(f"Saving {len(processed_data)} entries to {DATASET_CSV_PATH}...")
    
    with open(DATASET_CSV_PATH, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerow(['text', 'label']) # Write header
        writer.writerows(processed_data)
        
    print("Success! 'dataset.csv' has been created/updated.")
    print("You can now run 'train_model.py' to build your model.")

if __name__ == "__main__":
    main()